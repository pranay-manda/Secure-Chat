const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Android build requirements of the official libsignal (org.signal:libsignal-android), used by
 * modules/signal-protocol:
 *  1. Signal's Maven repository, where current libsignal-android releases are published.
 *  2. Core library desugaring, which the libsignal AAR metadata requires for the app module.
 */
const REPO = "maven { url 'https://build-artifacts.signal.org/libraries/maven/' }";
const MARKER = '// withLibsignalAndroid';
const DESUGAR_LIBS = 'com.android.tools:desugar_jdk_libs:2.1.5';

function addRepository(config) {
  return withProjectBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(MARKER)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /allprojects\s*\{\s*repositories\s*\{/,
        (block) => `${block}\n    ${REPO} ${MARKER}`,
      );
      if (!mod.modResults.contents.includes(MARKER)) {
        throw new Error('withLibsignalAndroid: allprojects.repositories block not found');
      }
    }
    return mod;
  });
}

function enableDesugaring(config) {
  return withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(MARKER)) {
      mod.modResults.contents += `
${MARKER}: libsignal-android requires core library desugaring
android {
    compileOptions {
        coreLibraryDesugaringEnabled true
    }
}
dependencies {
    coreLibraryDesugaring '${DESUGAR_LIBS}'
}
`;
    }
    return mod;
  });
}

module.exports = function withLibsignalAndroid(config) {
  return enableDesugaring(addRepository(config));
};
