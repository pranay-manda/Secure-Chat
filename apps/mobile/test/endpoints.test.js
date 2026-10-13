import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ENDPOINTS } from '../src/config/endpoints';

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

describe('API endpoints', () => {
  it('builds exactly the paths the API serves', () => {
    const id = '6ac789ca090b90edc7bf2623';
    const callId = '11111111-1111-4111-8111-111111111111';
    expect({
      otpRequest: ENDPOINTS.AUTH.OTP_REQUEST,
      otpVerify: ENDPOINTS.AUTH.OTP_VERIFY,
      refresh: ENDPOINTS.AUTH.REFRESH,
      logout: ENDPOINTS.AUTH.LOGOUT,
      account: ENDPOINTS.ACCOUNT.ROOT,
      keys: ENDPOINTS.KEYS.ROOT,
      keyStatus: ENDPOINTS.KEYS.STATUS,
      oneTime: ENDPOINTS.KEYS.ONE_TIME,
      bundle: ENDPOINTS.KEYS.bundle(id),
      messages: ENDPOINTS.MESSAGES.ROOT,
      envelopes: ENDPOINTS.MESSAGES.envelopes(42),
      envelopesAck: ENDPOINTS.MESSAGES.ENVELOPES_ACK,
      read: ENDPOINTS.MESSAGES.READ,
      status: ENDPOINTS.MESSAGES.STATUS,
      devices: ENDPOINTS.DEVICES.ROOT,
      pushToken: ENDPOINTS.DEVICES.PUSH_TOKEN,
      contacts: ENDPOINTS.CONTACTS.MATCH,
      pusherConfig: ENDPOINTS.REALTIME.CONFIG,
      pusherAuth: ENDPOINTS.REALTIME.AUTH,
      calls: ENDPOINTS.CALLS.ROOT,
      current: ENDPOINTS.CALLS.CURRENT,
      missed: ENDPOINTS.CALLS.MISSED,
      missedAck: ENDPOINTS.CALLS.MISSED_ACK,
      accept: ENDPOINTS.CALLS.accept(callId),
      reject: ENDPOINTS.CALLS.reject(callId),
      signal: ENDPOINTS.CALLS.signal(callId),
      end: ENDPOINTS.CALLS.end(callId),
    }).toEqual({
      otpRequest: '/auth/otp/request',
      otpVerify: '/auth/otp/verify',
      refresh: '/auth/refresh',
      logout: '/auth/logout',
      account: '/account',
      keys: '/keys',
      keyStatus: '/keys/status',
      oneTime: '/keys/one-time',
      bundle: `/keys/bundle/${id}`,
      messages: '/messages',
      envelopes: '/messages/envelopes?after=42',
      envelopesAck: '/messages/envelopes/ack',
      read: '/messages/read',
      status: '/messages/status',
      devices: '/devices',
      pushToken: '/devices/push-token',
      contacts: '/contacts/match',
      pusherConfig: '/pusher/config',
      pusherAuth: '/pusher/auth',
      calls: '/calls',
      current: '/calls/current',
      missed: '/calls/missed',
      missedAck: '/calls/missed/ack',
      accept: `/calls/${callId}/accept`,
      reject: `/calls/${callId}/reject`,
      signal: `/calls/${callId}/signal`,
      end: `/calls/${callId}/end`,
    });
  });

  it('is read-only', () => {
    expect(Object.isFrozen(ENDPOINTS)).toBe(true);
    for (const group of Object.values(ENDPOINTS)) expect(Object.isFrozen(group)).toBe(true);
  });

  it('is the only place in the app that spells out an API path', () => {
    const offenders = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(path.join('config', 'endpoints.js'))) continue;
      const code = readFileSync(file, 'utf8');
      // A request whose path is a string or template literal instead of an ENDPOINTS entry.
      if (/\b(apiRequest|send)\(\s*'[A-Z]+',\s*['"`]/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
