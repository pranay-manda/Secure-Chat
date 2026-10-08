const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Raised when Resend does not accept an email. Carries only the HTTP status and Resend's
 * error name: never the API key, the recipient or the message body, so it is safe to log.
 */
export class EmailDeliveryError extends Error {
  constructor(message, { status, resendError } = {}) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.status = status;
    this.resendError = resendError;
  }
}

/**
 * Minimal client for Resend's send-email endpoint (https://resend.com/docs/api-reference).
 * Uses the built-in fetch; `fetchImpl` is injectable for tests.
 *
 * @param {{ apiKey: string, from: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createResendClient({
  apiKey,
  from,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  async function send({ to, subject, text, html }) {
    let res;
    try {
      res = await fetchImpl(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No `cause`: network errors can echo request details.
      throw new EmailDeliveryError(
        err?.name === 'TimeoutError' ? 'Resend request timed out' : 'Resend request failed',
      );
    }

    if (!res.ok) {
      // Resend error bodies are { name, message }; `message` can quote the recipient.
      const body = await res.json().catch(() => null);
      const resendError = typeof body?.name === 'string' ? body.name.slice(0, 64) : undefined;
      throw new EmailDeliveryError(`Resend responded with HTTP ${res.status}`, {
        status: res.status,
        resendError,
      });
    }
  }

  return { send };
}
