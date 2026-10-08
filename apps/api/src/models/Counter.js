import mongoose from 'mongoose';

/** Atomic named counters (e.g. per-device envelope sequence numbers). */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Counter = mongoose.models.Counter ?? mongoose.model('Counter', counterSchema);

/** Returns the next value of `name` (1, 2, 3, ...). Works inside a transaction session. */
export async function nextSequence(name, { session } = {}) {
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  return counter.value;
}
