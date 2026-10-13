import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { openAttachment, useMediaStore } from '../../media/attachmentService';

/** True while the app is on screen (decrypted media is never produced in the background). */
export function useAppActive() {
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/**
 * Decrypts attachment `messageId` into a temporary private file while `enabled`, the component
 * is mounted and the app is on screen. The file is deleted on unmount, when disabled, and (by
 * the messaging engine) when the app goes to the background; it is then decrypted again on
 * return.
 *
 * @returns {{ uri: string | null, error: Error | null }}
 */
export function useDecryptedMedia(messageId, enabled) {
  const generation = useMediaStore((state) => state.plaintextGeneration);
  const active = useAppActive();
  const [result, setResult] = useState({ key: null, uri: null, error: null });
  const key = enabled && active ? `${messageId}:${generation}` : null;

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    let handle = null;
    openAttachment(messageId).then(
      (opened) => {
        if (cancelled) opened.release();
        else {
          handle = opened;
          setResult({ key, uri: opened.uri, error: null });
        }
      },
      (error) => !cancelled && setResult({ key, uri: null, error }),
    );
    return () => {
      cancelled = true;
      handle?.release();
    };
  }, [key, messageId]);

  // A result for an earlier key (other message, disabled, cleared) is never shown.
  return result.key === key && key ? result : { uri: null, error: null };
}
