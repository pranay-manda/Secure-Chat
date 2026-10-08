import mongoose from 'mongoose';

/**
 * A login session on one device. Holds only SHA-256 hashes of refresh tokens, never the tokens.
 * `usedRefreshTokenHashes` remembers recently rotated tokens so a replay is detected as reuse.
 */
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, immutable: true },
    refreshTokenHash: { type: String, required: true },
    usedRefreshTokenHashes: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: true },
);

sessionSchema.index({ userId: 1, deviceId: 1, revokedAt: 1 });
// MongoDB deletes sessions once they expire (revoked ones included).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session ?? mongoose.model('Session', sessionSchema);

/** Number of rotated refresh-token hashes kept for reuse detection. */
export const USED_TOKEN_HISTORY = 10;
