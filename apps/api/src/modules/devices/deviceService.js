import { ERROR_CODE } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { HttpError } from '../../middleware/errors.js';
import { Device } from '../../models/Device.js';
import { OneTimePreKey } from '../../models/OneTimePreKey.js';
import { Session } from '../../models/Session.js';

const MAX_LISTED_DEVICES = 50;

function toPublicDevice(device, currentDeviceId) {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    name: device.name,
    appVersion: device.appVersion,
    osVersion: device.osVersion,
    createdAt: device.createdAt,
    lastActiveAt: device.lastActiveAt,
    revokedAt: device.revokedAt,
    current: device.deviceId === currentDeviceId,
  };
}

export function createDeviceService({ logger }) {
  /** Updates metadata of the caller's own device (keys and push tokens join in later phases). */
  async function registerCurrentDevice(auth, details) {
    const device = await Device.findOneAndUpdate(
      { userId: auth.userId, deviceId: auth.deviceId, revokedAt: null },
      { $set: { ...details, lastActiveAt: new Date() } },
      { new: true, runValidators: true },
    ).lean();
    if (!device) {
      throw new HttpError(401, ERROR_CODE.DEVICE_REVOKED, 'This device was signed out');
    }
    return toPublicDevice(device, auth.deviceId);
  }

  async function listDevices(auth) {
    const devices = await Device.find({ userId: auth.userId })
      .sort({ createdAt: -1 })
      .limit(MAX_LISTED_DEVICES)
      .lean();
    return devices.map((device) => toPublicDevice(device, auth.deviceId));
  }

  /**
   * Revokes one of the caller's devices and every session on it. Idempotent.
   * Unknown or foreign device ids return 404 (no cross-user enumeration).
   */
  async function revokeDevice(auth, deviceId) {
    await mongoose.connection.transaction(async (session) => {
      const device = await Device.findOne({ userId: auth.userId, deviceId })
        .session(session)
        .lean();
      if (!device) throw new HttpError(404, ERROR_CODE.NOT_FOUND, 'Device not found');
      if (device.revokedAt) return;

      const now = new Date();
      await Device.updateOne(
        { _id: device._id },
        { $set: { revokedAt: now, revokedReason: 'revoked_by_user' } },
        { session },
      );
      await Session.updateMany(
        { userId: auth.userId, deviceId, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'device_revoked' } },
        { session },
      );
      // Unused one-time pre-keys of a revoked device must never be handed out.
      await OneTimePreKey.deleteMany({ deviceId }, { session });
    });
    logger.info({ userId: auth.userId, self: deviceId === auth.deviceId }, 'Device revoked');
  }

  return { registerCurrentDevice, listDevices, revokeDevice };
}
