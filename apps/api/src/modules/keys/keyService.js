import { ERROR_CODE, SIGNAL } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { HttpError } from '../../middleware/errors.js';
import { Device } from '../../models/Device.js';
import { OneTimePreKey } from '../../models/OneTimePreKey.js';

/**
 * Stores and serves PUBLIC Signal key material. Never receives, stores or returns private keys:
 * request schemas only accept public keys/signatures, and responses are built field by field.
 */
export function createKeyService({ logger }) {
  async function loadActiveDevice(auth) {
    const device = await Device.findOne({
      userId: auth.userId,
      deviceId: auth.deviceId,
      revokedAt: null,
    });
    if (!device) throw new HttpError(401, ERROR_CODE.DEVICE_REVOKED, 'This device was signed out');
    return device;
  }

  async function countOneTimePreKeys(deviceId, session) {
    return OneTimePreKey.countDocuments({ deviceId }).session(session ?? null);
  }

  async function insertOneTimePreKeys(auth, preKeys, session) {
    if (preKeys.length === 0) return;
    const existing = await countOneTimePreKeys(auth.deviceId, session);
    if (existing + preKeys.length > SIGNAL.ONE_TIME_PREKEY_MAX_STORED) {
      throw new HttpError(409, ERROR_CODE.PREKEY_LIMIT_EXCEEDED, 'Too many one-time pre-keys');
    }
    try {
      await OneTimePreKey.insertMany(
        preKeys.map((key) => ({
          userId: auth.userId,
          deviceId: auth.deviceId,
          keyId: key.keyId,
          publicKey: key.publicKey,
        })),
        { session, ordered: true },
      );
    } catch (err) {
      if (err?.code === 11000) {
        throw new HttpError(409, ERROR_CODE.VALIDATION_ERROR, 'Duplicate pre-key id');
      }
      throw err;
    }
  }

  /**
   * Registers (or rotates) this device's public keys. The identity key is fixed once set:
   * changing it requires a fresh OTP login, which clears the device's key registration.
   */
  async function registerKeys(auth, keys) {
    await mongoose.connection.transaction(async (session) => {
      const device = await Device.findOne({
        userId: auth.userId,
        deviceId: auth.deviceId,
        revokedAt: null,
      }).session(session);
      if (!device)
        throw new HttpError(401, ERROR_CODE.DEVICE_REVOKED, 'This device was signed out');

      if (device.signal && device.signal.identityKey !== keys.identityKey) {
        throw new HttpError(
          409,
          ERROR_CODE.IDENTITY_KEY_CONFLICT,
          'Identity key is already registered for this device',
        );
      }

      device.signal = {
        registrationId: keys.registrationId,
        identityKey: keys.identityKey,
        signedPreKey: keys.signedPreKey,
        kyberPreKey: keys.kyberPreKey,
      };
      await device.save({ session });
      await insertOneTimePreKeys(auth, keys.oneTimePreKeys ?? [], session);
    });
    logger.info({ userId: auth.userId }, 'Device keys registered');
    return getStatus(auth);
  }

  async function addOneTimePreKeys(auth, preKeys) {
    const device = await loadActiveDevice(auth);
    if (!device.signal) {
      throw new HttpError(409, ERROR_CODE.KEYS_NOT_REGISTERED, 'Register device keys first');
    }
    await mongoose.connection.transaction((session) =>
      insertOneTimePreKeys(auth, preKeys, session),
    );
    return getStatus(auth);
  }

  async function getStatus(auth) {
    const device = await loadActiveDevice(auth);
    return {
      registered: Boolean(device.signal),
      registrationId: device.signal?.registrationId ?? null,
      signedPreKeyId: device.signal?.signedPreKey.keyId ?? null,
      kyberPreKeyId: device.signal?.kyberPreKey.keyId ?? null,
      oneTimePreKeyCount: await countOneTimePreKeys(auth.deviceId),
    };
  }

  /**
   * Returns the public pre-key bundle for another user's active device and consumes one
   * one-time pre-key (each is served at most once). Bundles may omit the one-time key when
   * the pool is empty; libsignal then uses signed + Kyber pre-keys only.
   */
  async function getBundle(auth, targetUserId) {
    if (targetUserId === auth.userId) {
      throw new HttpError(400, ERROR_CODE.VALIDATION_ERROR, 'Cannot fetch your own bundle');
    }
    const device = await Device.findOne({
      userId: targetUserId,
      revokedAt: null,
      signal: mongoose.trusted({ $ne: null }),
    })
      .sort({ lastActiveAt: -1 })
      .lean();
    if (!device) {
      throw new HttpError(404, ERROR_CODE.KEYS_NOT_REGISTERED, 'No registered device for user');
    }

    const oneTime = await OneTimePreKey.findOneAndDelete(
      { deviceId: device.deviceId },
      { sort: { keyId: 1 } },
    ).lean();

    const { signal } = device;
    return {
      userId: String(device.userId),
      deviceId: device.deviceId,
      signalDeviceId: device.signalDeviceId,
      registrationId: signal.registrationId,
      identityKey: signal.identityKey,
      signedPreKey: pickSigned(signal.signedPreKey),
      kyberPreKey: pickSigned(signal.kyberPreKey),
      oneTimePreKey: oneTime ? { keyId: oneTime.keyId, publicKey: oneTime.publicKey } : null,
    };
  }

  /** Clears a device's key registration (fresh OTP login on the same install). */
  async function resetDeviceKeys({ userId, deviceId }, { session } = {}) {
    await Device.updateOne({ userId, deviceId }, { $set: { signal: null } }, { session });
    await OneTimePreKey.deleteMany({ deviceId }, { session });
  }

  return { registerKeys, addOneTimePreKeys, getStatus, getBundle, resetDeviceKeys };
}

function pickSigned(key) {
  return { keyId: key.keyId, publicKey: key.publicKey, signature: key.signature };
}
