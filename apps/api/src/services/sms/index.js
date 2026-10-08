/**
 * SMS provider interface: `{ sendOtp(phoneNumber, otp): Promise<void> }`.
 * A real provider (Twilio Verify, MSG91, ...) is added once chosen; env validation
 * refuses the console provider in production. `none` returns null (phone sign-in off).
 */

/**
 * Development only. Prints the OTP to the API terminal so you can log in without SMS.
 * Deliberately bypasses the application logger: OTPs must never reach log pipelines.
 */
function createConsoleSmsProvider() {
  return {
    async sendOtp(phoneNumber, otp) {
      const masked = `${phoneNumber.slice(0, 3)}****${phoneNumber.slice(-2)}`;
      process.stdout.write(`\n[DEV SMS] OTP for ${masked}: ${otp}  (development only)\n\n`);
    },
  };
}

export function createSmsProvider({ provider }) {
  switch (provider) {
    case 'console':
      return createConsoleSmsProvider();
    case 'none':
      return null;
    default:
      throw new Error(`Unknown SMS provider: ${provider}`);
  }
}
