import { z } from 'zod';

/**
 * Public, build-time configuration. EXPO_PUBLIC_* values are inlined into the JS bundle,
 * so they must never contain secrets.
 *
 * Expo only inlines `process.env.EXPO_PUBLIC_*` when accessed with dot notation,
 * so each variable is read explicitly here.
 */
const schema = z.object({
  apiUrl: z
    .url()
    .refine((value) => __DEV__ || value.startsWith('https://'), {
      message: 'must use https:// outside development builds',
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
