import { z } from 'zod';

/**
 * Public, build-time configuration. EXPO_PUBLIC_* values are inlined into the JS bundle,
 * so they must never contain secrets.
 *
 * Expo only inlines `process.env.EXPO_PUBLIC_*` when accessed with dot notation,
 * so each variable is read explicitly here.
 */
/** Hosts that only ever mean "this machine": never valid for a preview/production build. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * Release (preview/production) builds must talk to a real HTTPS server. Development builds may
 * use http:// and localhost (adb reverse, emulator, LAN IP).
 */
export function isAllowedApiUrl(value, { dev = __DEV__ } = {}) {
  if (dev) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const schema = z.object({
  apiUrl: z
    .url()
    .refine((value) => isAllowedApiUrl(value), {
      message: 'must be an https:// server (not localhost) outside development builds',
    })
    .transform((value) => value.replace(/\/+$/, '')),
});

function load() {
  const result = schema.safeParse({
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
  });
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid app configuration (check apps/mobile/.env): ${details.join('; ')}`);
  }
  return Object.freeze(result.data);
}

export const env = load();
