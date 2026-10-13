/* global jest */
/**
 * The yellow connection banner. A reconnect that finishes quickly (for example after the
 * photo picker) must not flash "Connecting…"; a slow one is announced, and offline is shown at
 * once.
 */
let React;
let act;
let create;
let ConnectionBanner;
let CONNECTING_NOTICE_DELAY_MS;
let messaging;
let connectivity;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  React = require('react');
  ({ act, create } = require('react-test-renderer'));
  ({
    ConnectionBanner,
    CONNECTING_NOTICE_DELAY_MS,
  } = require('../src/components/ConnectionBanner'));
  messaging = require('../src/messaging/messagingEngine');
  connectivity = require('../src/lib/connectivity');
  connectivity.useConnectivityStore.setState({
    network: 'connected',
    internetReachable: true,
    reachableAt: Date.now(),
    unreachableAt: 0,
  });
  messaging.useMessagingStore.setState({ realtime: 'connected' });
});

afterEach(() => {
  jest.useRealTimers();
});

const bannerText = (tree) => {
  const found = tree.root.findAll((node) => node.props.testID === 'connection-banner');
  return found.length ? found[0].props.children : null;
};

it('a quick reconnect shows nothing; a slow one says "Connecting…" after the delay', () => {
  let tree;
  act(() => {
    tree = create(React.createElement(ConnectionBanner));
  });
  expect(bannerText(tree)).toBeNull();

  act(() => messaging.useMessagingStore.setState({ realtime: 'connecting' }));
  act(() => jest.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS - 100));
  expect(bannerText(tree)).toBeNull();
  act(() => messaging.useMessagingStore.setState({ realtime: 'connected' })); // back in time
  act(() => jest.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS));
  expect(bannerText(tree)).toBeNull();

  // A slow reconnect: announced once the delay has passed, and gone when it connects.
  act(() => messaging.useMessagingStore.setState({ realtime: 'connecting' }));
  act(() => jest.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS));
  expect(bannerText(tree)).toBe('Connecting…');
  act(() => messaging.useMessagingStore.setState({ realtime: 'connected' }));
  expect(bannerText(tree)).toBeNull();

  // The next episode waits again.
  act(() => messaging.useMessagingStore.setState({ realtime: 'connecting' }));
  expect(bannerText(tree)).toBeNull();
});

it('offline is shown at once', () => {
  let tree;
  act(() => {
    tree = create(React.createElement(ConnectionBanner));
  });
  act(() => connectivity.useConnectivityStore.setState({ network: 'none' }));
  expect(bannerText(tree)).toMatch(/offline/i);
});
