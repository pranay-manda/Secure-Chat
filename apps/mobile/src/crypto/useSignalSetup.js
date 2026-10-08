import { useEffect, useState } from 'react';

import { isSignalAvailable } from '../../modules/signal-protocol';
import { ensureKeysRegistered } from './signalService';

/**
 * Registers/tops up this device's Signal keys once per signed-in app start.
 * Returns { state: 'idle'|'working'|'ready'|'unavailable'|'error', status, error }.
 */
export function useSignalSetup() {
  const [result, setResult] = useState(() => ({
    state: isSignalAvailable() ? 'working' : 'unavailable',
    status: null,
    error: null,
  }));

  useEffect(() => {
    if (!isSignalAvailable()) return undefined;
    let cancelled = false;
    ensureKeysRegistered()
      .then((status) => {
        if (!cancelled) setResult({ state: 'ready', status, error: null });
      })
      .catch((err) => {
        // Codes/messages from the API client and native module never contain key material.
        const error = [err?.code, err?.message].filter(Boolean).join(': ') || 'ERROR';
        if (__DEV__) console.warn('[signal] key setup failed:', error);
        if (!cancelled) setResult({ state: 'error', status: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}
