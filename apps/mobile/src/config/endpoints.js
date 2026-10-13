/**
 * Every API route the app calls, in one place. Paths are relative to the API base URL
 * (`env.apiUrl`, see lib/api.js); the HTTP method stays at the call site.
 *
 * Routes that contain an id are functions. They build exactly the same strings the app always
 * sent: ids are server-issued (ObjectId hex / UUID) and are interpolated as they are.
 */
export const ENDPOINTS = Object.freeze({
  AUTH: Object.freeze({
    OTP_REQUEST: '/auth/otp/request',
    OTP_VERIFY: '/auth/otp/verify',
    REFRESH: '/auth/refresh',
    LOGOUT: '/auth/logout',
  }),
  ACCOUNT: Object.freeze({
    /** GET: the signed-in account's details. DELETE: deletes the account. */
    ROOT: '/account',
    /** POST: add a phone number (accounts that have none). */
    PHONE: '/account/phone',
    /** POST: email a code to add an email (accounts that have none); then POST EMAIL. */
    EMAIL_OTP: '/account/email/otp',
    EMAIL: '/account/email',
  }),
  KEYS: Object.freeze({
    /** PUT: upload identity + signed + Kyber pre-keys. */
    ROOT: '/keys',
    STATUS: '/keys/status',
    ONE_TIME: '/keys/one-time',
    bundle: (peerUserId) => `/keys/bundle/${peerUserId}`,
  }),
  MESSAGES: Object.freeze({
    /** POST: send one encrypted message. */
    ROOT: '/messages',
    envelopes: (afterSeq) => `/messages/envelopes?after=${afterSeq}`,
    ENVELOPES_ACK: '/messages/envelopes/ack',
    READ: '/messages/read',
    STATUS: '/messages/status',
  }),
  DEVICES: Object.freeze({
    /** GET: this account's devices. */
    ROOT: '/devices',
    PUSH_TOKEN: '/devices/push-token',
  }),
  CONTACTS: Object.freeze({
    MATCH: '/contacts/match',
    /** GET: phone numbers of people (of these) who have messaged this user. */
    peers: (userIds) => `/contacts/peers?userIds=${userIds.join(',')}`,
  }),
  REALTIME: Object.freeze({
    CONFIG: '/pusher/config',
    AUTH: '/pusher/auth',
  }),
  PRESENCE: Object.freeze({
    /** DELETE: this device is going away. */
    ROOT: '/presence',
    HEARTBEAT: '/presence/heartbeat',
    TYPING: '/presence/typing',
    query: (userIds) => `/presence?userIds=${userIds.join(',')}`,
  }),
  ATTACHMENTS: Object.freeze({
    /** POST: reserve (or re-find) an upload slot for an encrypted blob. */
    ROOT: '/attachments',
    /** GET: a pre-signed download URL (uploader or recipient only). */
    byId: (attachmentId) => `/attachments/${attachmentId}`,
    complete: (attachmentId) => `/attachments/${attachmentId}/complete`,
    received: (attachmentId) => `/attachments/${attachmentId}/received`,
  }),
  CALLS: Object.freeze({
    /** POST: start a call. */
    ROOT: '/calls',
    CURRENT: '/calls/current',
    MISSED: '/calls/missed',
    MISSED_ACK: '/calls/missed/ack',
    accept: (callId) => `/calls/${callId}/accept`,
    reject: (callId) => `/calls/${callId}/reject`,
    signal: (callId) => `/calls/${callId}/signal`,
    end: (callId) => `/calls/${callId}/end`,
  }),
});
