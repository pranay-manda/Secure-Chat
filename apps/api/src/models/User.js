import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    /** E.164 format, e.g. +919876543210. Normalised before storage. */
    phoneNumber: { type: String, immutable: true },
    /**
     * When the phone number was proven by an SMS code (phone sign-in). Null for a number typed
     * at email sign-up: saved and used for contact discovery, but not verified.
     */
    phoneVerifiedAt: { type: Date, default: null },
    /** Lower-cased and trimmed before storage. */
    email: { type: String, immutable: true },
    displayName: { type: String, trim: true, maxlength: 64, default: '' },
    profilePhoto: { type: String, default: null },
    lastSeen: { type: Date, default: null },
  },
  { timestamps: true },
);

// Each identifier is optional on its own, so uniqueness applies only where it is set:
// a plain unique index would treat every missing value as a duplicate null.
userSchema.index(
  { phoneNumber: 1 },
  { unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } },
);
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);

userSchema.pre('validate', function requireIdentifier() {
  if (!this.phoneNumber && !this.email) {
    this.invalidate('email', 'A user needs an email address or a phone number');
  }
});

userSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);

/**
 * Phase 1 created `phoneNumber_1` as a plain unique index. Replace it with the partial one
 * declared above so email-only users can coexist. Idempotent; run once at startup.
 *
 * @returns {Promise<boolean>} true if the legacy index was replaced
 */
export async function migrateUserIndexes() {
  const indexes = await User.collection.indexes().catch((err) => {
    if (err?.codeName === 'NamespaceNotFound') return [];
    throw err;
  });
  const legacy = indexes.find(
    (index) => index.name === 'phoneNumber_1' && !index.partialFilterExpression,
  );
  if (legacy) await User.collection.dropIndex('phoneNumber_1');
  await User.createIndexes();
  return Boolean(legacy);
}
