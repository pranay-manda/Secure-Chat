/**
 * Dynamic additions to app.json (everything else stays in app.json).
 *
 * 1. Firebase (FCM) client config. `google-services.json` is gitignored, so EAS cloud builds do
 *    not receive it from the repository. Store it as an EAS *file* environment variable named
 *    GOOGLE_SERVICES_JSON (visibility "secret"); EAS writes it to a temporary file during the
 *    build and puts that path in the variable. Local builds keep using ./google-services.json.
 *    This is the Android client config only (no service-account private key, which never goes
 *    near the app: FCM server credentials live in the EAS project's push credentials).
 *
 * 2. API URL. EXPO_PUBLIC_API_URL comes from the EAS environment of the build profile (see
 *    eas.json `environment`). Preview/production builds are stopped here, at configuration
 *    time, if it is missing or not a real https:// server, instead of shipping an app that
 *    refuses to start (src/config/env.js applies the same rule at runtime).
 */
const RELEASE_PROFILES = new Set(['preview', 'production']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

function isReleaseApiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

module.exports = ({ config }) => {
  const profile = process.env.EAS_BUILD_PROFILE;
  if (RELEASE_PROFILES.has(profile) && !isReleaseApiUrl(process.env.EXPO_PUBLIC_API_URL)) {
    throw new Error(
      `EXPO_PUBLIC_API_URL must be set to an https:// server (not localhost) for the "${profile}" ` +
        'build profile. Add it to the EAS environment of this profile.',
    );
  }

  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? config.android.googleServicesFile,
    },
  };
};

module.exports.isReleaseApiUrl = isReleaseApiUrl;
