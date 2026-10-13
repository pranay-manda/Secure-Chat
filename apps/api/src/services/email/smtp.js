import nodemailer from 'nodemailer';

/** Bounds on a slow or unresponsive SMTP server, so a sign-in never hangs. */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Raised when an email was not accepted for delivery. Carries only the SMTP error code and
 * response code: never the password, the recipient or the message (which contains the OTP), so
 * it is safe to log.
 */
export class EmailDeliveryError extends Error {
  constructor(message, { code, responseCode } = {}) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code;
    this.responseCode = responseCode;
  }
}

/**
 * Transport options for an SMTP server. TLS is always used and certificates are always
 * verified: port 465 speaks TLS from the start; any other port (587, 25, ...) must upgrade with
 * STARTTLS (`requireTLS`), so a connection is never sent in plain text.
 *
 * @param {{ host: string, port: number, user: string, pass: string }} config
 */
export function smtpTransportOptions({ host, port, user, pass }) {
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host },
    // One connection is reused across emails instead of a new login for each code.
    pool: true,
    maxConnections: 2,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // Nodemailer must not write the conversation (with the code) to any log.
    logger: false,
    debug: false,
  };
}

/**
 * Minimal SMTP client over one reusable Nodemailer transporter.
 * `createTransport` is injectable so tests use a fake transport and send nothing.
 *
 * @param {{ host: string, port: number, user: string, pass: string, from: string,
 *           createTransport?: typeof nodemailer.createTransport }} options
 */
export function createSmtpClient({
  from,
  createTransport = nodemailer.createTransport,
  ...server
}) {
  const transporter = createTransport(smtpTransportOptions(server));

  async function send({ to, subject, text, html }) {
    let info;
    try {
      info = await transporter.sendMail({ from, to, subject, text, html });
    } catch (err) {
      // Only the codes: SMTP error messages can quote the recipient or the server's reply.
      throw new EmailDeliveryError('SMTP delivery failed', {
        code: typeof err?.code === 'string' ? err.code.slice(0, 32) : undefined,
        responseCode: Number.isInteger(err?.responseCode) ? err.responseCode : undefined,
      });
    }
    // Delivered only if the server accepted this recipient.
    const accepted = (info?.accepted ?? []).map((a) => String(a?.address ?? a).toLowerCase());
    if (!accepted.includes(String(to).toLowerCase())) {
      throw new EmailDeliveryError('SMTP server did not accept the recipient', {
        code: 'EENVELOPE',
      });
    }
  }

  return { send, close: () => transporter.close() };
}
