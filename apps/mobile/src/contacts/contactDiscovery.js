import { LIMITS } from '@secure-chat/shared/constants';
import * as Contacts from 'expo-contacts';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

import { ENDPOINTS } from '../config/endpoints';
import { apiRequest } from '../lib/api';
import { toE164 } from '../lib/phone';
import { withSystemUi } from '../lib/systemUi';
import {
  applyContactNames,
  listConversationsWithoutPhone,
  listUntitledConversationIds,
  listUntitledConversationPhones,
  setPeerPhones,
} from '../messaging/messageStore';

/**
 * Contact discovery: which people in this phone's address book use CipherChat?
 *
 * Privacy:
 *  - Contacts are read on the device only when the user opens New Chat.
 *  - Only normalized phone numbers are sent (in batches) to POST /contacts/match. Names,
 *    emails and every other contact field stay on the phone.
 *  - Nothing about the address book is stored, here or on the server. Matches are shown
 *    with the local contact name; that name is only saved (locally, encrypted) as a chat
 *    nickname if the user starts a chat.
 */

/** Contacts read from the device per page (keeps memory and UI work bounded). */
const READ_PAGE_SIZE = 500;

/** @returns {Promise<'granted'|'denied'|'undetermined'>} plus whether it can be asked again */
export async function getContactsPermission() {
  const { status, canAskAgain } = await Contacts.getPermissionsAsync();
  return { status, canAskAgain };
}

export async function requestContactsPermission() {
  const { status, canAskAgain } = await withSystemUi(() => Contacts.requestPermissionsAsync());
  return { status, canAskAgain };
}

/** "+91 ******3210": enough to recognize a contact without showing the full number. */
export function maskPhone(e164) {
  const parsed = parsePhoneNumberFromString(e164 ?? '');
  const national = parsed?.nationalNumber ?? String(e164 ?? '').replace(/\D/g, '');
  const cc = parsed?.countryCallingCode ? `+${parsed.countryCallingCode} ` : '';
  return `${cc}******${national.slice(-4)}`;
}

/**
 * Reads the address book page by page and returns Map(E.164 number -> local contact name).
 * Numbers that cannot be normalized are skipped; the first name seen for a number wins.
 */
export async function readPhoneBook() {
  const fields = [Contacts.ContactField.FULL_NAME, Contacts.ContactField.PHONES];
  const byNumber = new Map();
  for (let offset = 0; ; offset += READ_PAGE_SIZE) {
    const page = await Contacts.Contact.getAllDetails(fields, { limit: READ_PAGE_SIZE, offset });
    for (const contact of page) {
      for (const phone of contact.phones ?? []) {
        const e164 = toE164(phone.number);
        if (e164 && !byNumber.has(e164)) byNumber.set(e164, contact.fullName?.trim() || null);
      }
    }
    if (page.length < READ_PAGE_SIZE) break;
    // Yield between pages so a very large address book does not freeze the UI.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return byNumber;
}

/**
 * Finds which address-book numbers belong to CipherChat accounts.
 *
 * @param {{ myPhoneNumber?: string | null }} options
 * @returns {Promise<Array<{ userId, name, phoneNumber, maskedPhone }>>} sorted by name
 */
export async function discoverContacts({ myPhoneNumber = null } = {}) {
  const book = await readPhoneBook();
  const numbers = [...book.keys()].filter((n) => n !== myPhoneNumber);

  const matches = [];
  for (let i = 0; i < numbers.length; i += LIMITS.CONTACT_MATCH_BATCH_MAX) {
    const batch = numbers.slice(i, i + LIMITS.CONTACT_MATCH_BATCH_MAX);
    const result = await apiRequest('POST', ENDPOINTS.CONTACTS.MATCH, {
      body: { phoneNumbers: batch },
    });
    matches.push(...result.matches);
  }

  const seen = new Set();
  const people = [];
  for (const match of matches) {
    if (seen.has(match.userId)) continue;
    seen.add(match.userId);
    const maskedPhone = maskPhone(match.phoneNumber);
    people.push({
      userId: match.userId,
      // The user's own name for this contact; else their CipherChat name; else the number.
      name: book.get(match.phoneNumber) || match.displayName || maskedPhone,
      phoneNumber: match.phoneNumber,
      maskedPhone,
    });
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  // Chats that started with an incoming message have no name yet: use the contact name.
  await applyContactNames(people.filter((p) => p.name !== p.maskedPhone)).catch(() => {});
  return people;
}

/** Matches from discoverContacts kept briefly for the chat search (one upload per search). */
const CONTACTS_CACHE_MS = 10 * 60 * 1000;
let contactsCache = null; // { at, myPhoneNumber, people }

/**
 * discoverContacts, reused for up to 10 minutes: searching the chat list must not re-upload the
 * whole address book on every search (and eat into the per-number rate limit). Only runs if
 * Contacts permission was already granted; never prompts.
 *
 * @returns {Promise<Array<{ userId, name, phoneNumber, maskedPhone }> | null>} null without
 *   Contacts permission
 */
export async function getContactsOnApp({ myPhoneNumber = null } = {}) {
  const permission = await getContactsPermission();
  if (permission.status !== 'granted') return null;
  const fresh =
    contactsCache &&
    contactsCache.myPhoneNumber === myPhoneNumber &&
    Date.now() - contactsCache.at < CONTACTS_CACHE_MS;
  if (!fresh) {
    contactsCache = {
      at: Date.now(),
      myPhoneNumber,
      people: await discoverContacts({ myPhoneNumber }),
    };
  }
  return contactsCache.people;
}

/** Forgets cached matches (e.g. after the user granted Contacts permission). */
export function clearContactsCache() {
  contactsCache = null;
}

/**
 * Is this exact number (E.164) a CipherChat account? Sends only that number, like contact
 * discovery (same endpoint, same per-number rate limit).
 *
 * @returns {Promise<{ userId, phoneNumber, displayName } | null>}
 */
export async function lookupPhoneNumber(phoneNumber) {
  const { matches } = await apiRequest('POST', ENDPOINTS.CONTACTS.MATCH, {
    body: { phoneNumbers: [phoneNumber] },
  });
  return matches.find((m) => m.phoneNumber === phoneNumber) ?? null;
}

/** When each peer's phone number was last asked for (not answered: asked again later). */
const phoneAskedAt = new Map();
const PHONE_RETRY_MS = 60 * 1000;
const PHONE_BOOK_CACHE_MS = 10 * 60 * 1000;
let phoneBookCache = null; // { at, byNumber }
let namingPeers = null;

/** The address book (local read, nothing uploaded), reused briefly. Null without permission. */
async function localPhoneBook() {
  const { status } = await Contacts.getPermissionsAsync();
  if (status !== 'granted') return null;
  if (!phoneBookCache || Date.now() - phoneBookCache.at >= PHONE_BOOK_CACHE_MS) {
    phoneBookCache = { at: Date.now(), byNumber: await readPhoneBook() };
  }
  return phoneBookCache.byNumber;
}

/**
 * Names chats started by someone else, like WhatsApp: the server gives the phone number of
 * people who have messaged us (GET /contacts/peers), and the number is looked up in this
 * phone's address book locally (no upload). A contact shows with its contact name; anyone else
 * with their phone number. Runs when an unnamed chat appears; cheap when there is nothing to do.
 *
 * @returns {Promise<number>} conversations that got a number or a name
 */
export function namePeersFromServer() {
  namingPeers ??= (async () => {
    let changed = 0;
    const now = Date.now();
    const ask = (await listConversationsWithoutPhone())
      .filter((id) => now - (phoneAskedAt.get(id) ?? 0) >= PHONE_RETRY_MS)
      .slice(0, LIMITS.CONTACT_PEERS_MAX);
    if (ask.length > 0) {
      ask.forEach((id) => phoneAskedAt.set(id, now));
      const { peers } = await apiRequest('GET', ENDPOINTS.CONTACTS.peers(ask));
      changed += await setPeerPhones(peers);
    }

    const withPhone = await listUntitledConversationPhones();
    if (withPhone.length > 0) {
      const book = await localPhoneBook();
      if (book) {
        changed += await applyContactNames(
          withPhone.map((c) => ({ userId: c.peerUserId, name: book.get(c.peerPhone) ?? null })),
        );
      }
    }
    return changed;
  })()
    .catch(() => 0) // offline: asked again after PHONE_RETRY_MS
    .finally(() => {
      namingPeers = null;
    });
  return namingPeers;
}

/** Peers already looked up in this app session (avoids repeated address-book matching). */
const attempted = new Set();
let lastRun = 0;
let running = null;
const MIN_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Names unnamed conversations (e.g. someone in your contacts messaged you first) from the
 * address book. Runs only if Contacts permission was ALREADY granted (never prompts), only
 * when there is an unnamed chat not yet looked up, and at most every 2 minutes, so it does not
 * re-upload the address book needlessly or eat into the discovery rate limit.
 *
 * @returns {Promise<number>} conversations named
 */
export function nameConversationsFromContacts({ myPhoneNumber = null } = {}) {
  running ??= (async () => {
    const pending = (await listUntitledConversationIds()).filter((id) => !attempted.has(id));
    if (pending.length === 0 || Date.now() - lastRun < MIN_INTERVAL_MS) return 0;
    const { status } = await Contacts.getPermissionsAsync();
    if (status !== 'granted') return 0;

    lastRun = Date.now();
    pending.forEach((id) => attempted.add(id));
    const people = await discoverContacts({ myPhoneNumber });
    const untitled = new Set(pending);
    return people.filter((p) => untitled.has(p.userId) && p.name !== p.maskedPhone).length;
  })()
    .catch(() => 0)
    .finally(() => {
      running = null;
    });
  return running;
}
