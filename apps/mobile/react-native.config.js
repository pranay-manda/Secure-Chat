/**
 * Native autolinking overrides.
 *
 * react-native-reanimated and react-native-worklets are only optional peer dependencies of
 * expo-router / @expo/ui that npm installs automatically; this app does not use them, so their
 * native code is kept out of the build (smaller app, less native surface). Remove an entry here
 * if the library is adopted later.
 *
 * Note: an intermittent SIGSEGV in Fabric's MountingCoordinator::pullTransaction occurs only in
 * Android DEVELOPMENT builds (0 crashes in 25 release cold launches); see the Phase 2 crash report.
 */
module.exports = {
  dependencies: {
    'react-native-reanimated': { platforms: { android: null, ios: null } },
    'react-native-worklets': { platforms: { android: null, ios: null } },
  },
};
