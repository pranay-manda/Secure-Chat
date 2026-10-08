import { toE164 } from '../src/lib/phone';

describe('toE164', () => {
  it('normalises Indian numbers with or without +91', () => {
    expect(toE164('+91 98765 43210')).toBe('+919876543210');
    expect(toE164('98765-43210')).toBe('+919876543210');
  });

  it('keeps other country codes', () => {
    expect(toE164('+1 415 555 2671')).toBe('+14155552671');
  });

  it('rejects invalid input', () => {
    for (const input of ['', '12345', 'abc', '+91 123', null]) {
      expect(toE164(input)).toBeNull();
    }
  });
});
