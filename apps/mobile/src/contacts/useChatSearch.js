import { useEffect, useMemo, useState } from 'react';

import { useAuthStore } from '../auth/authStore';
import { toE164 } from '../lib/phone';
import { peerLabel } from '../messaging/hooks';
import {
  clearContactsCache,
  getContactsOnApp,
  lookupPhoneNumber,
  maskPhone,
  requestContactsPermission,
} from './contactDiscovery';

/** Wait this long after the last keystroke before asking the server about a typed number. */
export const LOOKUP_DEBOUNCE_MS = 500;
/** A query with at least this many digits may be a phone number worth looking up. */
const MIN_NUMBER_DIGITS = 8;

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

/**
 * WhatsApp-style search on the Chats tab:
 *  - chats: conversations whose name or last message matches (locked chats never appear);
 *  - contacts: people in this phone's address book who use CipherChat, by name or number
 *    (only with Contacts permission; the prompt appears only when the user asks for it);
 *  - number: a typed phone number is looked up on the server, so anyone can be found by their
 *    number even if they are not saved in the address book.
 *
 * @param {Array|null} conversations the unlocked chat list
 * @param {string} query
 * @param {boolean} active search is open
 */
export function useChatSearch(conversations, query, active) {
  const myPhoneNumber = useAuthStore((state) => state.user?.phoneNumber ?? null);
  const [contacts, setContacts] = useState({ status: 'idle', people: [] });
  const [lookup, setLookup] = useState({ number: null, status: 'idle', match: null });
  const q = query.trim().toLowerCase();
  const qDigits = digitsOf(q);

  // Address-book matches, once per search session (cached by contactDiscovery).
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    getContactsOnApp({ myPhoneNumber }).then(
      (people) =>
        !cancelled &&
        setContacts(
          people === null ? { status: 'no-permission', people: [] } : { status: 'ready', people },
        ),
      () => !cancelled && setContacts({ status: 'error', people: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [active, myPhoneNumber, contacts.reload]);

  const chats = useMemo(() => {
    if (!conversations || !q) return conversations ?? [];
    return conversations.filter(
      (c) =>
        peerLabel(c.peerUserId, c.title, c.peerPhone).toLowerCase().includes(q) ||
        (c.lastBody ?? '').toLowerCase().includes(q),
    );
  }, [conversations, q]);

  const people = useMemo(() => {
    if (!q) return [];
    const inChats = new Set(chats.map((c) => c.peerUserId));
    return contacts.people.filter(
      (p) =>
        !inChats.has(p.userId) &&
        (p.name.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && digitsOf(p.phoneNumber).includes(qDigits))),
    );
  }, [contacts.people, chats, q, qDigits]);

  // A typed phone number: ask the server (debounced), unless it is already listed above.
  const number = qDigits.length >= MIN_NUMBER_DIGITS ? toE164(query) : null;
  const knownNumber = Boolean(number) && contacts.people.some((p) => p.phoneNumber === number);
  useEffect(() => {
    if (!active || !number || knownNumber) return undefined;
    if (number === myPhoneNumber) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLookup({ number, status: 'loading', match: null });
      lookupPhoneNumber(number).then(
        (match) => !cancelled && setLookup({ number, status: match ? 'found' : 'none', match }),
        () => !cancelled && setLookup({ number, status: 'error', match: null }),
      );
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, number, knownNumber, myPhoneNumber]);

  const numberResult =
    !number || knownNumber
      ? null
      : number === myPhoneNumber
        ? { number, status: 'self', match: null }
        : lookup.number === number
          ? lookup
          : { number, status: 'loading', match: null };

  /** Asks for Contacts permission (only on the user's tap) and reloads the matches. */
  async function allowContacts() {
    const result = await requestContactsPermission();
    clearContactsCache();
    setContacts((c) => ({ ...c, reload: (c.reload ?? 0) + 1, status: 'idle' }));
    return result;
  }

  return {
    chats,
    people,
    contactsStatus: contacts.status,
    numberResult,
    allowContacts,
    maskPhone,
  };
}
