import { REALTIME_EVENT } from '@secure-chat/shared/constants';
// The React Native build of pusher-js (picked by Metro) exports the class as `Pusher`.
import { Pusher } from 'pusher-js';

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
 *   onSubscribed: () => void,
 *   onStateChange: (state: string) => void,
 * }} handlers
 * @returns {Promise<() => void>} disconnect function
 */
export async function connectRealtime({ onEnvelope, onReceipt, onSubscribed, onStateChange }) {
  const { realtime, channel: channelName } = await apiRequest('GET', '/pusher/config');
  if (!realtime) {
    onStateChange('unavailable');
    return () => {};
  }

  const pusher = new Pusher(realtime.key, {
    cluster: realtime.cluster,
    forceTLS: true,
    channelAuthorization: {
      // Goes through apiRequest: access token attached and refreshed like any API call.
      customHandler: ({ socketId, channelName: name }, callback) => {
        apiRequest('POST', '/pusher/auth', { body: { socketId, channelName: name } }).then(
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

  return () => {
    channel.unbind_all();
    pusher.unsubscribe(channelName);
    pusher.disconnect();
  };
}
