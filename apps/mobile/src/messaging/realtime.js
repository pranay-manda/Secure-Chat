import { REALTIME_EVENT } from '@secure-chat/shared/constants';
// The React Native build of pusher-js (picked by Metro) exports the class as `Pusher`.
import { Pusher } from 'pusher-js';

import { ENDPOINTS } from '../config/endpoints';
import { apiRequest } from '../lib/api';

/**
 * Pusher Channels connection for this device. Realtime is only an accelerator: every event it
 * carries can also be recovered over HTTPS, so failures here never lose messages.
 *
 * The app holds only the public Pusher key and cluster (served by the API). Subscribing to the
 * private device channel is authorised by our own API (POST /pusher/auth), which signs only
 * this device's channel; the Pusher secret stays on the server.
 *
 * @param {{
 *   onEnvelope: (payload: object) => void,
 *   onReceipt: (payload: { receipts: object[] }) => void,
 *   onCall?: (payload: object) => void,
 *   onTyping?: (payload: object) => void,
 *   onPresence?: (payload: object) => void,
 *   onSubscribed: () => void,
 *   onStateChange: (state: string) => void,
 * }} handlers
 * @returns {Promise<() => void>} disconnect function
 */
export async function connectRealtime({
  onEnvelope,
  onReceipt,
  onCall,
  onTyping,
  onPresence,
  onSubscribed,
  onStateChange,
}) {
  const { realtime, channel: channelName } = await apiRequest('GET', ENDPOINTS.REALTIME.CONFIG);
  if (!realtime) {
    onStateChange('unavailable');
    return () => {};
  }

  const pusher = new Pusher(realtime.key, {
    cluster: realtime.cluster,
    forceTLS: true,
    // Notice a dead socket (e.g. after a network switch) in ~40 s instead of pusher-js's
    // default 120 s + 30 s. pusher-js then reconnects with backoff on its own.
    activityTimeout: 30_000,
    pongTimeout: 10_000,
    channelAuthorization: {
      // Goes through apiRequest: access token attached and refreshed like any API call.
      customHandler: ({ socketId, channelName: name }, callback) => {
        apiRequest('POST', ENDPOINTS.REALTIME.AUTH, { body: { socketId, channelName: name } }).then(
          (auth) => callback(null, auth),
          (err) => callback(err, null),
        );
      },
    },
  });

  pusher.connection.bind('state_change', ({ current }) => onStateChange(current));
  const channel = pusher.subscribe(channelName);
  // Fires on the first subscription and again after every reconnect: the caller syncs then,
  // which recovers anything published while the connection was down.
  channel.bind('pusher:subscription_succeeded', onSubscribed);
  channel.bind(REALTIME_EVENT.ENVELOPE, onEnvelope);
  channel.bind(REALTIME_EVENT.RECEIPT, onReceipt);
  // Voice-call signaling on the same device channel (signaling only; audio is WebRTC).
  if (onCall) channel.bind(REALTIME_EVENT.CALL, onCall);
  // Real-time typing indicators.
  if (onTyping) channel.bind(REALTIME_EVENT.TYPING, onTyping);
  // Online/offline changes of people this user chats with.
  if (onPresence) channel.bind(REALTIME_EVENT.PRESENCE, onPresence);

  const disconnect = () => {
    channel.unbind_all();
    pusher.unsubscribe(channelName);
    pusher.disconnect();
  };
  /**
   * The phone switched networks or came back online: a socket bound to the old interface may
   * hang until the activity timeout, so reconnect now. pusher-js re-subscribes (which fires
   * `subscription_succeeded`, so the caller syncs) and the channel bindings stay in place.
   */
  disconnect.reconnect = () => {
    pusher.disconnect();
    pusher.connect();
  };
  return disconnect;
}
