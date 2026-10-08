import mongoose from 'mongoose';

/**
 * Public one-time pre-keys. Each is handed out at most once (atomic findOneAndDelete) to a
 * peer starting a session. The matching private keys exist only on the owning device.
 */
const oneTimePreKeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true },
    keyId: { type: Number, required: true },
    publicKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oneTimePreKeySchema.index({ deviceId: 1, keyId: 1 }, { unique: true });

export const OneTimePreKey =
  mongoose.models.OneTimePreKey ?? mongoose.model('OneTimePreKey', oneTimePreKeySchema);
