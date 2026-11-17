/**
 * Exact double-precision summation.
 *
 * Reproducibility requirement: a group's sum must not depend on how rows were
 * split into tasks, which worker got them, or the order they arrived. Plain
 * `+=` fails that: floating-point addition is not associative, so a 240-row
 * sum split into 1 task and into 240 tasks gives different last bits.
 *
 * Approach: every finite double is an exact integer multiple of 2^-1074
 * (the smallest subnormal), so we accumulate the exact sum as a BigInt at that
 * scale and round once at the end (round-half-to-even). The accumulator is an
 * integer: addition is associative and commutative, so the result is
 * bit-identical regardless of partition or order. Verified against CPython's
 * math.fsum, which does the correctly-rounded exact sum by a different route.
 *
 * Cost: BigInt arithmetic per value, ~10-20x a float add. For rule workloads
 * (hundreds of thousands of rows) this is well within budget, and it is the
 * only way to make "batch size does not change the answer" literally true.
 */

const view = new DataView(new ArrayBuffer(8));

export const ZERO = 0n;

/** Exact value of a finite double, scaled by 2^1074. */
export function toScaledInteger(v) {
  if (v === 0) return 0n;
  view.setFloat64(0, v);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 ? -1n : 1n;
  const rawExp = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent;
  if (rawExp === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = rawExp - 1023 - 52;
  }
  return negative * (mantissa << BigInt(exponent + 1074));
}

/** Round an exact 2^-1074-scaled integer to the nearest double (ties to even). */
export function scaledIntegerToDouble(n) {
  if (n === 0n) return 0;
  const negative = n < 0n;
  const magnitude = negative ? -n : n;
  const bitLength = magnitude.toString(2).length;
  const leadingExponent = bitLength - 1 - 1074;

  if (leadingExponent > 1023) return negative ? -Infinity : Infinity;

  // Subnormal (or exactly representable with <53 bits below 2^-1022): the
  // scaled integer has at most 52 significant bits, so Number() is exact.
  if (leadingExponent < -1022) {
    const result = Number(magnitude) * 2 ** -1074;
    return negative ? -result : result;
  }

  const shift = bitLength - 53;
  if (shift <= 0) {
    const result = Number(magnitude) * 2 ** -1074;
    return negative ? -result : result;
  }
  const bigShift = BigInt(shift);
  let mantissa = magnitude >> bigShift;
  const remainder = magnitude & ((1n << bigShift) - 1n);
  const halfway = 1n << BigInt(shift - 1);
  if (remainder > halfway || (remainder === halfway && (mantissa & 1n) === 1n)) {
    mantissa += 1n;
  }
  const result = Number(mantissa) * 2 ** (shift - 1074);
  return negative ? -result : result;
}

export function addExact(acc, v) {
  return acc + toScaledInteger(v);
}

export function exactSumToDouble(acc) {
  return scaledIntegerToDouble(acc);
}

/** Serialise an exact accumulator for cross-task merging. */
export function serializeExact(acc) {
  return acc.toString();
}

export function deserializeExact(text) {
  return BigInt(text);
}
