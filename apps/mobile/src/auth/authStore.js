import { DEVICE_PLATFORM, ERROR_CODE } from '@secure-chat/shared/constants';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { apiRequest, setSessionEndedHandler } from '../lib/api';
import { getDeviceId, resetDeviceId } from '../lib/deviceId';
import { restoreSession, startSession, wipeLocalSession } from './session';

const LOGOUT_TIMEOUT_MS = 5000;

export const AUTH_STATUS = Object.freeze({
  INITIALIZING: 'initializing',
  SIGNED_OUT: 'signedOut',
  SIGNED_IN: 'signedIn',
});

function deviceDetails(deviceId) {
  return {
    deviceId,
    platform: Platform.OS === 'ios' ? DEVICE_PLATFORM.IOS : DEVICE_PLATFORM.ANDROID,
    name: String(Platform.constants?.Model ?? Platform.OS).slice(0, 64),
    appVersion: String(Constants.expoConfig?.version ?? '').slice(0, 32),
    osVersion: String(Platform.Version ?? '').slice(0, 32),
  };
}

/**
 * Sign-in identifier sent to the API: `{ email }` or `{ phoneNumber }`.
 * A bare string is read as a phone number (the Phase 1 call style).
 */
function identifierBody(identifier) {
  return typeof identifier === 'string' ? { phoneNumber: identifier } : identifier;
}

export const useAuthStore = create((set, get) => ({
  status: AUTH_STATUS.INITIALIZING,
  user: null,
  /** Why the user was signed out without asking (shown once on the login screen). */
  notice: null,

  /** Restores the session on app start; safe to call more than once. */
  async initialize() {
    if (get().status !== AUTH_STATUS.INITIALIZING) return;
    try {
      await getDeviceId();
      const user = await restoreSession();
      set({ status: user ? AUTH_STATUS.SIGNED_IN : AUTH_STATUS.SIGNED_OUT, user });
    } catch {
      // Unreadable local state must never brick the app: start clean.
      await wipeLocalSession().catch(() => {});
      set({ status: AUTH_STATUS.SIGNED_OUT, user: null });
    }
  },

  /** @returns {Promise<{ expiresInSeconds: number, resendAfterSeconds: number }>} */
  async requestOtp(identifier) {
    return apiRequest('POST', '/auth/otp/request', {
      body: identifierBody(identifier),
      auth: false,
    });
  },

  async verifyOtp(identifier, otp) {
    const deviceId = await getDeviceId();
    try {
      const result = await apiRequest('POST', '/auth/otp/verify', {
        body: { ...identifierBody(identifier), otp, device: deviceDetails(deviceId) },
        auth: false,
      });
      await startSession(result);
      set({ status: AUTH_STATUS.SIGNED_IN, user: result.user, notice: null });
      return result.user;
    } catch (err) {
      // This install's deviceId was revoked: switch to a new one so the next code works.
      if (err?.code === ERROR_CODE.DEVICE_REVOKED) await resetDeviceId();
      throw err;
    }
  },

  /** Ends the session on the server (best effort) and always wipes local credentials and data. */
  async logout() {
    try {
      await apiRequest('POST', '/auth/logout', { timeoutMs: LOGOUT_TIMEOUT_MS });
    } catch {
      // Offline or already expired: local wipe below still signs the user out.
    }
    await wipeLocalSession();
    set({ status: AUTH_STATUS.SIGNED_OUT, user: null, notice: null });
  },

  /** Called by the API client when the server ends the session (revoked, reused, expired). */
  async handleSessionEnded(code) {
    if (get().status === AUTH_STATUS.SIGNED_OUT) return;
    await wipeLocalSession({ newDeviceId: code === ERROR_CODE.DEVICE_REVOKED });
    set({
      status: AUTH_STATUS.SIGNED_OUT,
      user: null,
      notice: 'You were signed out. Please sign in again.',
    });
  },

  clearNotice() {
    set({ notice: null });
  },
}));

setSessionEndedHandler((code) => useAuthStore.getState().handleSessionEnded(code));
