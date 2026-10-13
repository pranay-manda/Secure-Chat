require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SignalProtocol'
  s.version        = package['version']
  s.summary        = 'Stateless Expo bridge to the official libsignal (LibSignalClient)'
  s.description    = 'Exposes libsignal operations to JS; all state is persisted by JS in SQLCipher/SecureStore.'
  s.author         = 'CipherChat'
  s.homepage       = 'https://github.com/pranay-manda/Secure-Chat'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The official Signal client library. CocoaPods resolves it from the Podfile entry added by
  # plugins/withLibsignalIos.js (git tag v0.105.0 — keep in lockstep with the Android bridge's
  # org.signal:libsignal-android and the test suite's @signalapp/libsignal-client).
  s.dependency 'LibSignalClient'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = '**/*.swift'
end
