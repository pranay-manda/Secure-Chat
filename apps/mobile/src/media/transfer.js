import { File } from 'expo-file-system';

import { env, isAllowedApiUrl } from '../config/env';
import { ApiError, NetworkError } from '../lib/api';

/**
 * Moves encrypted blobs to and from attachment storage through the pre-signed URLs the API
 * hands out (`{ url, method, headers }`). Transfers are streamed natively by expo-file-system:
 * the bytes never pass through JavaScript, and they are already encrypted.
 *
 * A relative URL belongs to the API itself (local storage driver); an absolute one (object
 * storage) must be https in release builds, like the API URL.
 */
export function resolveTransferUrl(url) {
  if (typeof url !== 'string' || url.length === 0) throw new Error('Missing transfer URL');
  if (url.startsWith('/') && !url.startsWith('//')) return `${env.apiUrl}${url}`;
  if (!isAllowedApiUrl(url)) throw new Error('Refusing a non-https transfer URL');
  return url;
}

/** HTTP status worth retrying with a fresh URL (expired link, overload, server trouble). */
const isRetryableStatus = (status) =>
  status === 403 || status === 408 || status === 429 || status >= 500;

function statusError(status) {
  return isRetryableStatus(status)
    ? new NetworkError(`Transfer failed (HTTP ${status})`)
    : new ApiError(status, 'TRANSFER_REJECTED', `Transfer rejected (HTTP ${status})`);
}

/** Uploads `file` (an encrypted blob) to `target`. Throws NetworkError (retry) or ApiError. */
export async function uploadFile(file, target, { onProgress } = {}) {
  const task = file.createUploadTask(resolveTransferUrl(target.url), {
    httpMethod: target.method ?? 'PUT',
    headers: target.headers ?? {},
    ...(onProgress && {
      onProgress: ({ bytesSent, totalBytes }) => onProgress(bytesSent / (totalBytes || 1)),
    }),
  });
  let result;
  try {
    result = await task.uploadAsync();
  } catch {
    throw new NetworkError('Upload interrupted');
  } finally {
    task.release?.();
  }
  if (result.status < 200 || result.status >= 300) throw statusError(result.status);
}

export class TransferSizeError extends Error {
  constructor() {
    super('The download is not the expected size');
    this.name = 'TransferSizeError';
  }
}

/**
 * Downloads exactly `expectedBytes` from `target` into `dest`. A download that grows beyond
 * that is aborted (a misbehaving server cannot fill the phone's storage) and a short one is
 * refused. The caller verifies the digest and tag before trusting the file.
 */
export async function downloadFile(target, dest, { expectedBytes, onProgress }) {
  const controller = new AbortController();
  let oversize = false;
  const task = File.createDownloadTask(resolveTransferUrl(target.url), dest, {
    headers: target.headers ?? {},
    signal: controller.signal,
    onProgress: ({ bytesWritten }) => {
      if (bytesWritten > expectedBytes) {
        oversize = true;
        controller.abort();
      } else onProgress?.(bytesWritten / expectedBytes);
    },
  });
  try {
    await task.downloadAsync();
  } catch (err) {
    if (oversize) throw new TransferSizeError();
    const status = Number(
      /HTTP (\d{3})|status: (\d{3})/
        .exec(err?.message ?? '')
        ?.slice(1)
        .find(Boolean),
    );
    throw Number.isInteger(status) ? statusError(status) : new NetworkError('Download interrupted');
  } finally {
    task.release?.();
  }
  if (!dest.exists || dest.size !== expectedBytes) throw new TransferSizeError();
}
