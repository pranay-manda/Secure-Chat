import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { ApiError, NetworkError } from '../lib/api';
import { isSignalAvailable } from '../../modules/signal-protocol';
import { ensureKeysRegistered } from './signalService';

/** Waits between attempts while the server cannot be reached (the last one repeats). */
export const SETUP_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 10_000, 30_000]);

/** The server could not be reached or was briefly unavailable: worth trying again. */
const isRetryable = (err) =>
  err instanceof NetworkError ||
  (err instanceof ApiError && (err.status >= 500 || err.status === 429));

/**
 * Registers/tops up this device's Signal keys once per signed-in app start.
 * Returns { state: 'idle'|'working'|'ready'|'unavailable'|'error', status, error }.
 *
 * Messaging starts only once this succeeds, so an app opened without a connection (airplane
 * mode, no signal, server down) keeps trying: on a backoff timer, when the network comes back
 * and when the app returns to the foreground. Otherwise it would stay offline until restarted.
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
    let running = false;
    let done = false;
    let failures = 0; // retryable failures so far (sets the backoff)
    let retrying = false; // the last failure was retryable
    let timer = null;

    const attempt = () => {
      if (cancelled || running || done) return;
      clearTimeout(timer);
      running = true;
      ensureKeysRegistered()
        .then((status) => {
          done = true;
          if (!cancelled) setResult({ state: 'ready', status, error: null });
        })
        .catch((err) => {
          // Codes/messages from the API client and native module never contain key material.
          const error = [err?.code, err?.message].filter(Boolean).join(': ') || 'ERROR';
          if (__DEV__) console.warn('[signal] key setup failed:', error);
          if (cancelled) return;
          setResult({ state: 'error', status: null, error });
          retrying = isRetryable(err);
          if (!retrying) return;
          const delay = SETUP_RETRY_DELAYS_MS[Math.min(failures, SETUP_RETRY_DELAYS_MS.length - 1)];
          failures += 1;
          timer = setTimeout(attempt, delay);
        })
        .finally(() => {
          running = false;
        });
    };

    // Back online or back in the app after a failed attempt: try now rather than at the timer.
    const unsubscribeNet = NetInfo.addEventListener((net) => {
      if (retrying && net?.isConnected) attempt();
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (retrying && state === 'active') attempt();
    });

    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribeNet();
      appState.remove();
    };
  }, []);

  return result;
}
