/**
 * Push delivery through the Expo push service, which forwards to FCM V1 (Android) using the
 * service account configured in the EAS project, so this server holds no Firebase credentials.
 *
 * Provider interface: `{ send(message): Promise<{ ok: boolean, error?: string }> }` where
 * `error` is a delivery error code (e.g. `DeviceNotRegistered`). Network/HTTP failures throw.
 * Never log the message: the `to` field is a push token.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const REQUEST_TIMEOUT_MS = 10_000;

export class PushDeliveryError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'PushDeliveryError';
    this.status = status;
  }
}

function createExpoPushProvider({ accessToken, fetchImpl = fetch }) {
  return {
    async send(message) {
      let res;
      try {
        res = await fetchImpl(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            // Required only when "enhanced push security" is enabled for the Expo project.
            ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
          },
          body: JSON.stringify([message]),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new PushDeliveryError(
          err?.name === 'TimeoutError' ? 'Push request timed out' : 'Push request failed',
        );
      }
      if (!res.ok) {
        throw new PushDeliveryError(`Push service HTTP ${res.status}`, { status: res.status });
      }

      const body = await res.json().catch(() => null);
      const ticket = body?.data?.[0];
      if (ticket?.status === 'ok') return { ok: true };
      return { ok: false, error: String(ticket?.details?.error ?? 'Unknown').slice(0, 64) };
    },
  };
}

/**
 * @param {{ provider: 'expo' | 'none', accessToken?: string }} config
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createPushProvider(config, { fetchImpl } = {}) {
  switch (config.provider) {
    case 'expo':
      return createExpoPushProvider({ accessToken: config.accessToken, fetchImpl });
    case 'none':
      return null;
    default:
      throw new Error(`Unknown push provider: ${config.provider}`);
  }
}
