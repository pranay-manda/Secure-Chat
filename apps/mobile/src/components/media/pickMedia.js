import * as ImagePicker from 'expo-image-picker';

import { withSystemUi } from '../../lib/systemUi';

const BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
};

/** MIME type of a picked asset: the picker's, else from the file extension, else by kind. */
export function contentTypeOf(asset) {
  if (/^(image|video)\/[a-z0-9.+-]+$/i.test(asset.mimeType ?? '')) {
    return asset.mimeType.toLowerCase();
  }
  const extension = /\.([a-z0-9]+)$/i.exec(asset.uri ?? '')?.[1]?.toLowerCase();
  return BY_EXTENSION[extension] ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
}

/**
 * Lets the user choose one photo or video with the system photo picker. Needs no storage or
 * media permission: Android's photo picker hands the app a single copy (in the app's private
 * cache), which is encrypted and then deleted. Photos are re-compressed (quality 0.8); their
 * GPS location is removed before encryption.
 *
 * @returns {Promise<object | null>} `{ uri, contentType, width, height, durationMs }` or null
 */
export async function pickPhotoOrVideo() {
  // The picker is our own screen: the user stays in the app (no reconnect on return).
  const result = await withSystemUi(() =>
    ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: false,
      allowsEditing: false,
      quality: 0.8,
      exif: false,
      base64: false,
    }),
  );
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    contentType: contentTypeOf(asset),
    width: asset.width,
    height: asset.height,
    durationMs: asset.type === 'video' ? asset.duration : undefined,
  };
}
