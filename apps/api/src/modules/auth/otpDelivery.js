import { OTP_CHANNEL } from '@secure-chat/shared/constants';

/**
 * The only channel-specific part of OTP sign-in: getting the code to the user.
 * A null provider means that channel is switched off (e.g. no SMS provider yet).
 *
 * @param {{
 *   smsProvider: { sendOtp(phone: string, otp: string): Promise<void> } | null,
 *   emailProvider: { sendOtp(email: string, otp: string): Promise<void> } | null,
 * }} providers
 */
export function createOtpDelivery({ smsProvider, emailProvider }) {
  const enabled = {
    [OTP_CHANNEL.EMAIL]: Boolean(emailProvider),
    [OTP_CHANNEL.PHONE]: Boolean(smsProvider),
  };

  return {
    isEnabled: (channel) => enabled[channel] === true,
    sendEmailOTP: (email, otp) => emailProvider.sendOtp(email, otp),
    sendPhoneOTP: (phoneNumber, otp) => smsProvider.sendOtp(phoneNumber, otp),
  };
}
