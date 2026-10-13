import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Bottom padding that keeps a screen's bottom edge (e.g. the chat composer) just above the
 * on-screen keyboard.
 *
 * The app is edge-to-edge: the screen reaches the bottom of the display, behind the navigation
 * bar, and the window does not resize for the keyboard. On Android, React Native reports the
 * keyboard height WITHOUT the navigation bar (`ime - systemBars` in ReactRootView), which is
 * right for apps that stop above the bar but leaves an edge-to-edge screen short by exactly the
 * bar's height: hidden behind the keyboard on phones with the 3-button navigation bar. So the
 * bar (the bottom safe-area inset) is added back on Android. iOS reports the full height.
 *
 * Without a keyboard, the padding is the bottom safe-area inset (clear of the navigation bar).
 */
export function keyboardInset({ keyboardHeight, safeBottom, platform = Platform.OS }) {
  if (!(keyboardHeight > 0)) return safeBottom;
  return platform === 'android' ? keyboardHeight + safeBottom : keyboardHeight;
}

export function useKeyboardInset() {
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      // Also fires when the height changes while open (suggestion strip, emoji panel).
      Keyboard.addListener(show, (e) => setKeyboardHeight(e.endCoordinates.height)),
      Keyboard.addListener(hide, () => setKeyboardHeight(0)),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);
  return keyboardInset({ keyboardHeight, safeBottom: insets.bottom });
}
