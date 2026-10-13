import { CALL_TERMINAL_STATUSES } from '@secure-chat/shared/constants';

/**
 * Transient 1:1 call state in Redis. Nothing here is durable on purpose: call history lives
 * only on the phones, audio never touches the server, and SDP/ICE candidates are relayed,
 * never stored. Every key has a TTL, so even a lost timer or a crashed server cannot leave a
 * call ringing forever.
 *
 *   call:{callId}          hash   callId, callerUserId, callerDeviceId, calleeUserId,
 *                                 calleeDeviceId, status, reason, createdAt, ringExpiresAt,
 *                                 answeredAt, endedAt, kind (voice | video)
 *   call:user:{userId}     string the user's current call id ("busy" marker, one call at a time)
 *   call:missed:{userId}   hash   callId -> JSON { callId, callerUserId, createdAt, endedAt }:
 *                                 unanswered calls, kept only until the user's phone collects
 *                                 them for its local call history (it may have been closed
 *                                 while the call rang). Capped, and expires as a whole.
 *
 * All state changes are Lua scripts, so each is atomic: two racing requests (accept vs cancel,
 * duplicate accepts...) can never both succeed.
 */
const callKey = (callId) => `call:${callId}`;
const userKey = (userId) => `call:user:${userId}`;
const missedKey = (userId) => `call:missed:${userId}`;

const TERMINAL = CALL_TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

// A user is free if they have no busy marker, or it points to a call that is gone or over.
const IS_FREE = `
local terminal = {${TERMINAL}}
local function isFree(busyKey)
  local id = redis.call('GET', busyKey)
  if not id then return true end
  local status = redis.call('HGET', 'call:' .. id, 'status')
  if not status then return true end
  for _, t in ipairs(terminal) do if status == t then return true end end
  return false
end
`;

/**
 * KEYS: call, callerBusy, calleeBusy. ARGV: callId, ttlMs, then field/value pairs.
 * Returns {'OK'} | {'CALLER_BUSY'} | {'CALLEE_BUSY'}.
 */
const CREATE = `${IS_FREE}
if not isFree(KEYS[2]) then return {'CALLER_BUSY'} end
if not isFree(KEYS[3]) then return {'CALLEE_BUSY'} end
-- Field by field: Redis runs Lua 5.1 (global unpack), the test double Lua 5.3 (table.unpack).
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('SET', KEYS[2], ARGV[1], 'PX', tonumber(ARGV[2]))
redis.call('SET', KEYS[3], ARGV[1], 'PX', tonumber(ARGV[2]))
return {'OK'}
`;

/**
 * KEYS: call, callerBusy, calleeBusy.
 * ARGV: callId, newStatus, ttlMs, terminal ('1'|'0'), fieldCount, f1, v1, ..., allowed...
 * Returns {'OK', previous} | {'INVALID', current} | {'MISSING'}.
 */
const TRANSITION = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return {'MISSING'} end
local fieldCount = tonumber(ARGV[5])
local firstAllowed = 6 + fieldCount * 2
local allowed = false
for i = firstAllowed, #ARGV do if ARGV[i] == current then allowed = true end end
if not allowed then return {'INVALID', current} end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
for i = 6, firstAllowed - 1, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
local ttl = tonumber(ARGV[3])
redis.call('PEXPIRE', KEYS[1], ttl)
for _, busy in ipairs({KEYS[2], KEYS[3]}) do
  if redis.call('GET', busy) == ARGV[1] then
    if ARGV[4] == '1' then redis.call('DEL', busy) else redis.call('PEXPIRE', busy, ttl) end
  end
end
return {'OK', current}
`;

/**
 * KEYS: missed. ARGV: callId, json, ttlMs, max. Adds (or keeps) one note unless the user
 * already has `max` uncollected ones, and restarts the expiry. Returns 1 if stored, else 0.
 */
const ADD_MISSED = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0
   and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

const FIELDS = [
  'callId',
  'callerUserId',
  'callerDeviceId',
  'calleeUserId',
  'calleeDeviceId',
  'status',
  'reason',
  'createdAt',
  'ringExpiresAt',
  'answeredAt',
  'endedAt',
  'kind',
];

export function createCallStore(redis) {
  if (!redis.callCreate) {
    redis.defineCommand('callCreate', { numberOfKeys: 3, lua: CREATE });
    redis.defineCommand('callTransition', { numberOfKeys: 3, lua: TRANSITION });
  }
  if (!redis.callAddMissed) {
    redis.defineCommand('callAddMissed', { numberOfKeys: 1, lua: ADD_MISSED });
  }

  /** @returns {Promise<'OK'|'CALLER_BUSY'|'CALLEE_BUSY'>} */
  async function create(call, ttlMs) {
    const pairs = Object.entries(call).flatMap(([field, value]) => [field, String(value ?? '')]);
    const [result] = await redis.callCreate(
      callKey(call.callId),
      userKey(call.callerUserId),
      userKey(call.calleeUserId),
      call.callId,
      ttlMs,
      ...pairs,
    );
    return result;
  }

  /** The call, or null if unknown/expired. Empty fields come back as null. */
  async function get(callId) {
    const values = await redis.hmget(callKey(callId), ...FIELDS);
    if (!values[0]) return null;
    return Object.fromEntries(FIELDS.map((field, i) => [field, values[i] || null]));
  }

  /**
   * Atomically moves the call from one of `from` to `to`.
   * @returns {Promise<{ ok: true, previous: string } | { ok: false, current: string | null }>}
   */
  async function transition(call, { from, to, ttlMs, terminal, fields = {} }) {
    const pairs = Object.entries(fields).flatMap(([field, value]) => [field, String(value)]);
    const [result, status] = await redis.callTransition(
      callKey(call.callId),
      userKey(call.callerUserId),
      userKey(call.calleeUserId),
      call.callId,
      to,
      ttlMs,
      terminal ? '1' : '0',
      pairs.length / 2,
      ...pairs,
      ...from,
    );
    if (result === 'OK') return { ok: true, previous: status };
    return { ok: false, current: status ?? null };
  }

  /** The id of the user's current call (if any marker exists; the call may already be over). */
  async function currentCallId(userId) {
    return redis.get(userKey(userId));
  }

  /** Stores a missed-call note for `userId`. @returns {Promise<boolean>} false if over the cap */
  async function addMissed(userId, notice, { ttlMs, max }) {
    const stored = await redis.callAddMissed(
      missedKey(userId),
      notice.callId,
      JSON.stringify(notice),
      ttlMs,
      max,
    );
    return Number(stored) === 1;
  }

  /** The user's uncollected missed-call notes, oldest first. */
  async function listMissed(userId) {
    const entries = await redis.hvals(missedKey(userId));
    return entries
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async function removeMissed(userId, callIds) {
    if (callIds.length > 0) await redis.hdel(missedKey(userId), ...callIds);
  }

  async function clearMissed(userId) {
    await redis.del(missedKey(userId));
  }

  return {
    create,
    get,
    transition,
    currentCallId,
    addMissed,
    listMissed,
    removeMissed,
    clearMissed,
  };
}
