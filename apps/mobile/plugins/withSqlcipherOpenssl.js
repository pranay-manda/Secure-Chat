const fs = require('fs');
const path = require('path');

const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * expo-sqlite's SQLCipher build links dynamically against OpenSSL's libcrypto.so from the
 * `io.github.ronickg:openssl` AAR, but that AAR ships the library only in `prefab/` form
 * (for compiling) with no `jni/` folder, and expo-sqlite declares it `compileOnly`. Result:
 * libcrypto.so is never packaged and opening a database fails at runtime with
 * "dlopen failed: library libcrypto.so not found".
 *
 * This plugin extracts libcrypto.so for every ABI from that same AAR (the exact version
 * expo-sqlite compiled against, read from its build.gradle) and packages it with the app.
 * No crypto code is changed; this is packaging only.
 */
const MARKER = '// withSqlcipherOpenssl';

function readOpensslCoordinate() {
  const gradlePath = path.join(
    path.dirname(require.resolve('expo-sqlite/package.json')),
    'android',
    'build.gradle',
  );
  const match = /compileOnly\s+'(io\.github\.ronickg:openssl:[^']+)'/.exec(
    fs.readFileSync(gradlePath, 'utf8'),
  );
  if (!match) {
    throw new Error(
      'withSqlcipherOpenssl: OpenSSL dependency not found in expo-sqlite build.gradle',
    );
  }
  return match[1];
}

function gradleBlock(coordinate) {
  return `
${MARKER}: package OpenSSL libcrypto.so required by SQLCipher (expo-sqlite)
configurations { sqlcipherOpenssl }
dependencies { sqlcipherOpenssl '${coordinate}@aar' }
def sqlcipherOpensslJniDir = layout.buildDirectory.dir('generated/sqlcipher-openssl/jniLibs')
def extractSqlcipherOpenssl = tasks.register('extractSqlcipherOpenssl', Copy) {
  from({ zipTree(configurations.sqlcipherOpenssl.singleFile) }) {
    include 'prefab/modules/crypto/libs/android.*/libcrypto.so'
    eachFile { details ->
      def abi = details.relativePath.segments[4].replace('android.', '')
      details.relativePath = new RelativePath(true, abi, 'libcrypto.so')
    }
  }
  includeEmptyDirs = false
  into sqlcipherOpensslJniDir
}
android.sourceSets.main.jniLibs.srcDir(sqlcipherOpensslJniDir)
tasks.named('preBuild') { dependsOn extractSqlcipherOpenssl }
`;
}

module.exports = function withSqlcipherOpenssl(config) {
  return withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(MARKER)) {
      mod.modResults.contents += gradleBlock(readOpensslCoordinate());
    }
    return mod;
  });
};
