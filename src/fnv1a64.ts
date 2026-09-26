/**
 * FNV-1a 64-bit, computed over two unsigned 32-bit halves.
 *
 * Why this exists: the obvious implementation keeps the running hash in a
 * `BigInt` and performs a BigInt XOR + multiply + mask for EVERY input unit.
 * Each of those allocates, so hashing a large canonical string (a response
 * body, the projected tool registry) costs a heap allocation per character.
 * On the operator main thread that showed up as the hottest JS function in
 * event-loop-saturation profiles (WI-10003260).
 *
 * This version is bit-exact with the BigInt reference: it produces the same
 * 64-bit value, so every revision / fingerprint / cursor string derived from
 * it is unchanged. Only the final formatting touches BigInt, once per hash.
 *
 * Arithmetic: prime = 2^40 + 0x1b3, so for h = hi·2^32 + lo,
 *   h·prime mod 2^64 = h·0x1b3 + (lo mod 2^24)·2^40
 * which lands in the halves as
 *   lo' = (lo·0x1b3) mod 2^32
 *   hi' = (hi·0x1b3 + carry(lo·0x1b3) + lo·2^8) mod 2^32
 * Every intermediate stays below 2^43, so plain doubles are exact.
 */

const OFFSET_HI = 0xcbf29ce4;
const OFFSET_LO = 0x84222325;
const PRIME_LO = 0x1b3;
const TWO_32 = 4294967296;

/** Running state: [hi, lo] unsigned 32-bit halves of the 64-bit hash. */
type Fnv64State = [number, number];

function step(state: Fnv64State, unit: number): void {
  const lo = (state[1] ^ unit) >>> 0;
  const t = lo * PRIME_LO;
  const tLo = t >>> 0;
  const carry = (t - tLo) / TWO_32;
  state[0] = (state[0] * PRIME_LO + carry + lo * 256) >>> 0;
  state[1] = tLo;
}

function toBigInt(state: Fnv64State): bigint {
  return (BigInt(state[0]) << 32n) | BigInt(state[1]);
}

/**
 * FNV-1a 64 over a string's UTF-16 CODE UNITS (`charCodeAt`), as the delta
 * protocol has always hashed. Returns the value in base 36.
 */
export function fnv1a64CodeUnitsBase36(str: string): string {
  const state: Fnv64State = [OFFSET_HI, OFFSET_LO];
  for (let i = 0; i < str.length; i++) step(state, str.charCodeAt(i));
  return toBigInt(state).toString(36);
}

/**
 * FNV-1a 64 over BYTES (e.g. the UTF-8 encoding of a string). Returns the
 * value as 16 zero-padded lowercase hex digits.
 */
export function fnv1a64BytesHex(bytes: Uint8Array): string {
  const state: Fnv64State = [OFFSET_HI, OFFSET_LO];
  for (let i = 0; i < bytes.length; i++) step(state, bytes[i]!);
  return toBigInt(state).toString(16).padStart(16, '0');
}
