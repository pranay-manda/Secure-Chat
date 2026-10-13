import { createElement } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Renders one WebRTC video stream (ours or the other phone's) by its opaque stream id. The
 * native view is loaded lazily, like the rest of the call libraries, so screens that import
 * this render fine where react-native-webrtc is absent (tests); then nothing is drawn.
 */
let RTCView;
function nativeView() {
  if (RTCView === undefined) {
    try {
      ({ RTCView } = require('react-native-webrtc'));
    } catch {
      RTCView = null;
    }
  }
  return RTCView;
}

export function VideoView({ streamUrl, mirror = false, style, testID }) {
  if (!nativeView() || !streamUrl) {
    return <View style={[styles.empty, style]} testID={testID} />;
  }
  return createElement(nativeView(), {
    streamURL: streamUrl,
    mirror,
    objectFit: 'cover',
    zOrder: mirror ? 1 : 0, // our preview sits on top of their full-screen video (Android)
    style,
    testID,
  });
}

const styles = StyleSheet.create({ empty: { backgroundColor: '#000' } });
