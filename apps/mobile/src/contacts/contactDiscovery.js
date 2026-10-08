import { LIMITS } from '@secure-chat/shared/constants';
import * as Contacts from 'expo-contacts';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

import { apiRequest } from '../lib/api';
import { toE164 } from '../lib/phone';
import { applyContactNames, listUntitledConversationIds } from '../messaging/messageStore';

/**
 * Contact discovery: which people in this phone's address book use Secure Chat?
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
  const { status, canAskAgain } = await Contacts.requestPermissionsAsync();
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
 * Finds which address-book numbers belong to Secure Chat accounts.
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
    const result = await apiRequest('POST', '/contacts/match', { body: { phoneNumbers: batch } });
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
      // The user's own name for this contact; else their Secure Chat name; else the number.
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
