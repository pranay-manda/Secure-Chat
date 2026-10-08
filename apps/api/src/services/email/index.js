import { createResendClient } from './resend.js';

/**
 * Email provider interface: `{ sendOtp(email, otp): Promise<void> }`, mirroring the SMS one.
 * `none` returns null (email sign-in off); env validation refuses `console` in production.
 */

/** The sign-in email. Contains only the code: no name, account or device details. */
export function buildOtpEmail({ otp, expiresInMinutes }) {
  const expiry = `This code expires in ${expiresInMinutes} minute${expiresInMinutes === 1 ? '' : 's'}.`;
  const ignore = 'If you did not request this code, you can ignore this email.';
  return {
    subject: 'Your Secure Chat verification code',
    text: `Your verification code is: ${otp}\n\n${expiry}\n${ignore}\n`,
    html: [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1b1f23">',
      '<p>Your verification code is:</p>',
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p>`,
      `<p>${expiry}</p>`,
      `<p style="color:#5f6b76">${ignore}</p>`,
      '</div>',
    ].join(''),
  };
}

function createResendEmailProvider({ resendApiKey, from, otpTtlSeconds }, { fetchImpl } = {}) {
  const client = createResendClient({ apiKey: resendApiKey, from, fetchImpl });
  const expiresInMinutes = Math.max(1, Math.round(otpTtlSeconds / 60));
  return {
    async sendOtp(email, otp) {
      await client.send({ to: email, ...buildOtpEmail({ otp, expiresInMinutes }) });
    },
  };
}

/**
 * Development only. Prints the OTP to the API terminal so you can log in without email.
 * Deliberately bypasses the application logger: OTPs must never reach log pipelines.
 */
function createConsoleEmailProvider() {
  return {
    async sendOtp(email, otp) {
      const [local, domain] = email.split('@');
      const masked = `${local.slice(0, 1)}***@${domain}`;
      process.stdout.write(`\n[DEV EMAIL] OTP for ${masked}: ${otp}  (development only)\n\n`);
    },
  };
}

/**
 * @param {ReturnType<typeof import('../../config/env.js').loadEnv>['email']} config
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createEmailProvider(config, options) {
  switch (config.provider) {
    case 'resend':
      return createResendEmailProvider(config, options);
    case 'console':
      return createConsoleEmailProvider();
    case 'none':
      return null;
    default:
      throw new Error(`Unknown email provider: ${config.provider}`);
  }
}
