const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * react-native-webrtc's library manifest declares a screen-sharing foreground service
 * (`MediaProjectionService`, type mediaProjection). CipherChat only makes voice calls and never
 * shares the screen, so the declaration is removed from the merged manifest: an app should not
 * declare foreground-service types it does not use (Google Play reviews each declared type).
 */
const SERVICE = 'com.oney.WebRTCModule.MediaProjectionService';

function removeScreenShareService(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  manifest.manifest.$ = {
    ...manifest.manifest.$,
    'xmlns:tools': manifest.manifest.$?.['xmlns:tools'] ?? 'http://schemas.android.com/tools',
  };
  app.service = (app.service ?? []).filter((service) => service.$?.['android:name'] !== SERVICE);
  app.service.push({ $: { 'android:name': SERVICE, 'tools:node': 'remove' } });
  return manifest;
}

/**
 * Video calls use the camera, but the app is still useful without one (messaging, voice
 * calls): declare the hardware as optional so Google Play does not hide the app from devices
 * without a camera (a `CAMERA` permission alone implies a required camera).
 */
const CAMERA_FEATURE = 'android.hardware.camera';

function markCameraOptional(manifest) {
  const features = (manifest.manifest['uses-feature'] ??= []);
  const existing = features.find((feature) => feature.$?.['android:name'] === CAMERA_FEATURE);
  if (existing) existing.$['android:required'] = 'false';
  else features.push({ $: { 'android:name': CAMERA_FEATURE, 'android:required': 'false' } });
  return manifest;
}

module.exports = function withVoiceCallsAndroid(config) {
  return withAndroidManifest(config, (mod) => {
    mod.modResults = markCameraOptional(removeScreenShareService(mod.modResults));
    return mod;
  });
};
module.exports.removeScreenShareService = removeScreenShareService;
module.exports.markCameraOptional = markCameraOptional;
