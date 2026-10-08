import { DEVICE_PLATFORM, SIGNAL } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

/** A signed public pre-key (EC or Kyber). Public data only. */
const signedPublicKeySchema = new mongoose.Schema(
  {
    keyId: { type: Number, required: true },
    publicKey: { type: String, required: true },
    signature: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * Public Signal Protocol material for one device. The server never sees private keys:
 * devices generate everything locally and upload only these public halves.
 */
const signalKeysSchema = new mongoose.Schema(
  {
    registrationId: { type: Number, required: true },
    identityKey: { type: String, required: true },
    signedPreKey: { type: signedPublicKeySchema, required: true },
    kyberPreKey: { type: signedPublicKeySchema, required: true },
  },
  { _id: false },
);

/**
 * One row per app install per user. `deviceId` is a UUID v4 generated on the device.
 * Revoked devices stay revoked permanently: a reinstall/re-login must use a new deviceId.
 */
const deviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, immutable: true },
    /** Numeric device id in the Signal address (userId, signalDeviceId). Always 1 in v1. */
    signalDeviceId: { type: Number, default: SIGNAL.DEFAULT_DEVICE_ID },
    platform: { type: String, enum: Object.values(DEVICE_PLATFORM), required: true },
    name: { type: String, trim: true, maxlength: 64, default: '' },
    appVersion: { type: String, trim: true, maxlength: 32, default: '' },
    osVersion: { type: String, trim: true, maxlength: 32, default: '' },
    signal: { type: signalKeysSchema, default: null },
    lastActiveAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: true },
);

deviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
deviceSchema.index({ userId: 1, revokedAt: 1 });

export const Device = mongoose.models.Device ?? mongoose.model('Device', deviceSchema);
