import { keyboardInset } from '../src/components/useKeyboardInset';

/**
 * The chat composer must sit just above the keyboard on every phone. On Android, React Native
 * reports the keyboard height without the navigation bar, which an edge-to-edge screen still
 * extends behind, so the bar is added back (it was hidden on a 3-button-navigation moto g85).
 */
describe('keyboard inset', () => {
  it('Android: keyboard height plus the navigation bar (3-button bar ~48dp)', () => {
    expect(keyboardInset({ keyboardHeight: 280, safeBottom: 48, platform: 'android' })).toBe(328);
  });

  it('Android with gesture navigation: the small inset is added too', () => {
    expect(keyboardInset({ keyboardHeight: 300, safeBottom: 16, platform: 'android' })).toBe(316);
    expect(keyboardInset({ keyboardHeight: 300, safeBottom: 0, platform: 'android' })).toBe(300);
  });

  it('iOS already reports the full height', () => {
    expect(keyboardInset({ keyboardHeight: 336, safeBottom: 34, platform: 'ios' })).toBe(336);
  });

  it('without a keyboard, stays clear of the navigation bar', () => {
    expect(keyboardInset({ keyboardHeight: 0, safeBottom: 48, platform: 'android' })).toBe(48);
    expect(keyboardInset({ keyboardHeight: 0, safeBottom: 34, platform: 'ios' })).toBe(34);
  });
});
