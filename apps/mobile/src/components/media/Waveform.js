import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { resampleLevels } from '../../media/waveform';

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MIN_BAR = 3;

/**
 * Voice-note bars. `levels` are 0…1 (null = no waveform: flat bars). Bars before `progress`
 * (0…1) use `playedColor`. With `onSeek`, a tap or drag anywhere on it seeks (fraction 0…1),
 * and a dot marks the position, like WhatsApp.
 */
export function Waveform({
  levels,
  progress = 0,
  color,
  playedColor,
  height = 28,
  onSeek,
  testID,
}) {
  const [width, setWidth] = useState(0);
  const bars = Math.max(8, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
  const values = levels ? resampleLevels(levels, bars) : Array(bars).fill(0.12);
  const played = Math.round(Math.min(1, Math.max(0, progress)) * bars);

  const seekAt = (event) => {
    if (!onSeek || width <= 0) return;
    onSeek(Math.min(1, Math.max(0, event.nativeEvent.locationX / width)));
  };

  return (
    <View
      style={[styles.root, { height }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      testID={testID}
    >
      <View style={styles.bars} pointerEvents="none">
        {values.map((value, i) => (
          <View
            // Bars are positional; their count only changes with the width.
            key={i}
            style={{
              width: BAR_WIDTH,
              marginRight: BAR_GAP,
              borderRadius: BAR_WIDTH / 2,
              height: Math.max(MIN_BAR, Math.round(value * height)),
              backgroundColor: i < played ? playedColor : color,
            }}
          />
        ))}
      </View>
      {onSeek ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.thumb,
              {
                backgroundColor: playedColor,
                top: height / 2 - 6,
                left: Math.max(0, Math.min(width - 12, progress * width - 6)),
              },
            ]}
          />
          {/* Touch layer on top, so touch positions are relative to the whole waveform. */}
          <View
            style={StyleSheet.absoluteFill}
            onStartShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={seekAt}
            onResponderMove={seekAt}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Playback position"
            testID={testID ? `${testID}-seek` : undefined}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  thumb: { position: 'absolute', width: 12, height: 12, borderRadius: 6 },
});
