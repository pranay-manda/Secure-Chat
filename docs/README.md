# CipherChat (Secure Chat) — Feature documentation

This folder documents every feature of the Secure Chat app (visible name **CipherChat**). Each
feature has its own file, written from the code as it is on **2026-10-12**. For the system as a
whole (components, trust boundaries, data model, decision log), read
[ARCHITECTURE.md](ARCHITECTURE.md).

Every feature document has the same sections: summary, status, flow with Mermaid diagrams,
packages and versions, source files, API endpoints, MongoDB / Redis / on-phone storage, security
measures, error handling, configuration, testing status, and known limitations.

## Status legend

| Mark                       | Meaning                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| ✅ Implemented             | Built and covered by automated tests. Device testing is stated per part. |
| 🟡 Partially implemented   | The main flow works, but some named parts are missing or unverified.     |
| ⏳ Pending                 | Not built yet.                                                           |
| "device-verified"          | Tried on real Android phones (debug builds), with the date.              |
| "not verified on a device" | Only automated tests cover it so far.                                    |

## Features

| #   | Document                                                             | Status     | In one line                                                                                                  |
| --- | -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| 01  | [OTP login](01-otp-login.md)                                         | 🟡 Partial | Email + phone sign-up, code sent by email (SMTP); phone sign-in has no SMS provider yet                      |
| 02  | [Session management](02-session-management.md)                       | ✅         | Access/refresh tokens with rotation and reuse detection, one active device, sign-out wipe                    |
| 03  | [End-to-end encryption](03-end-to-end-encryption.md)                 | ✅         | Signal protocol (libsignal 0.105.0) on the phone; the server only sees ciphertext                            |
| 04  | [One-to-one messaging](04-one-to-one-messaging.md)                   | ✅         | Encrypted text messages, per-device envelopes, delivery and read receipts                                    |
| 05  | [Encrypted media](05-encrypted-media.md)                             | 🟡 Partial | Photos, videos and voice notes encrypted on the phone; only the `local` storage driver exists                |
| 06  | [Key management](06-key-management.md)                               | ✅         | Identity and pre-keys made on the phone, top-up and rotation, security-code changes                          |
| 07  | [Local database encryption](07-local-database-encryption.md)         | ✅         | One SQLCipher database, random key kept in SecureStore                                                       |
| 08  | [Real-time messaging](08-real-time-messaging.md)                     | ✅         | Private Pusher channel per device; everything can also be recovered over HTTPS                               |
| 09  | [Chat Lock](09-chat-lock.md)                                         | ✅         | Per-chat lock with the phone's fingerprint or screen lock, hidden "Locked chats" folder, screenshot blocking |
| 10  | [Voice and video calls](10-voice-video-calls.md)                     | 🟡 Partial | 1:1 WebRTC calls with keys verified through Signal; no TURN server, no full-screen incoming call             |
| 11  | [Push notifications](11-push-notifications.md)                       | ✅ Android | Expo push → FCM for messages and calls, with no content in the notification                                  |
| 12  | [Crash recovery](12-crash-recovery.md)                               | ✅         | What recovers after app kills, crashes, network loss and server restarts                                     |
| 13  | [Contact discovery and search](13-contact-discovery-and-search.md)   | ✅         | Find contacts who use the app; Chats header search incl. exact phone-number lookup                           |
| 14  | [Presence and typing](14-presence-and-typing.md)                     | 🟡 Partial | Live online/offline status; typing indicator lacks tests and an audience check                               |
| 15  | [Account and device management](15-account-and-device-management.md) | 🟡 Partial | Add missing email/phone, devices list, account deletion; no revoke button in the app                         |

Features 13–15 were not in the original list; they exist in the code, so they have their own
documents.

## What was tested on real phones

Debug builds on Android phones (RMX2103 Android 11, RMX3085 Android 13, RMX3851 Android 16, and
others named in the documents). The details and dates are in each document's "Testing status".

- Sign-up/sign-in with an email code (code read from the development API log, not from an
  inbox), and the one-time "Add your email/phone" screen.
- Encrypted text messages, photos, videos and voice notes between two phones.
- Online/offline status updating live; Chats header search including number lookup.
- Voice and video calls in both directions, background and return, network switch, call keys
  verified through Signal (R2), a security-code change blocking calls until accepted.
- Incoming call via push to a backgrounded app.

## Not built yet, or not verified

| Item                                                       | State                                          |
| ---------------------------------------------------------- | ---------------------------------------------- |
| Real code email arriving in an inbox (SMTP)                | SMTP login verified; inbox delivery not yet    |
| SMS provider for phone sign-in                             | ⏳ Not chosen; phone sign-in off in production |
| Release APK                                                | ⏳ Needs an HTTPS API address                  |
| iOS (build, device testing, media, push)                   | ⏳ Not tested                                  |
| TURN server for calls behind strict networks               | ⏳ Not configured                              |
| Cloud storage (S3/R2) for attachments                      | ⏳ Only the `local` driver exists              |
| Full-screen incoming-call screen (ConnectionService)       | ⏳ Not built                                   |
| Revoke a device from the app                               | ⏳ API exists, no button                       |
| Group chats, multi-device, profile editing, Status updates | ⏳ Not in v1                                   |
| Message pushes, Chat Lock, typing indicator on a device    | Not verified on a device                       |

## Issues found while writing these documents

These were found in the code during the review. None was changed (documentation only); each is
described in the linked document.

1. `POST /presence/typing` does not check that the two users share a chat, and has no API
   tests ([14](14-presence-and-typing.md)).
2. The Devices screen cannot revoke a device, although ARCHITECTURE.md says it can
   ([15](15-account-and-device-management.md)).
3. After a sign-in on another phone, the old phone keeps its device id until its next sign-in
   fails once with `DEVICE_REVOKED`, so the user must request a second code
   ([02](02-session-management.md)).
4. `POST /auth/logout` has no per-user rate limit, unlike other authenticated routes
   ([02](02-session-management.md)).
5. `clearPendingTaps()` (drop queued notification taps at sign-out) is never called, and push
   receipts are never fetched ([11](11-push-notifications.md)).
6. `expo-file-system` is imported by the app but not declared in `apps/mobile/package.json`
   ([05](05-encrypted-media.md)).
7. The call foreground-service notification says "Voice call in progress" during video calls
   too ([10](10-voice-video-calls.md)).

Some parts of ARCHITECTURE.md are out of date compared with the code; for example, it still uses
"Secure Chat" in notification and banner texts, and some Phase 6/7/10 notes predate the device
tests. The feature documents follow the code.

## Automated tests

On 2026-10-12: API 286, mobile 518 and shared 16 tests passing; lint and Prettier clean. Run
them with `npm test` from the repository root (run the API and mobile suites one at a time on a
slow machine).

## Keeping these documents up to date

- Change the document in the same change as the feature.
- Write only what the code does. Mark anything not tried on a phone as "not verified on a
  device".
- Never put secrets, codes, tokens, keys or real emails/phone numbers in a document.
- Diagrams use Mermaid and must render on GitHub: quote labels that contain spaces or
  punctuation.
