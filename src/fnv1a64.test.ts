import { describe, expect, it } from 'vitest';
import { fnv1a64BytesHex, fnv1a64CodeUnitsBase36 } from './fnv1a64';

/**
 * The former per-unit BigInt implementations, kept verbatim as the reference
 * the fast 16-bit-limb version must match bit-for-bit (WI-10003260). Every
 * revision / fingerprint / cursor string is derived from these values, so any
 * divergence would silently invalidate stored cursors and registry revisions.
 */
function referenceCodeUnitsBase36(str: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}

function referenceBytesHex(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Deterministic pseudo-random strings covering the full UTF-16 code-unit range. */
function randomStrings(count: number, seed: number): string[] {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const len = next() % 300;
    let str = '';
    for (let i = 0; i < len; i++) {
      // Mix ASCII, BMP and lone surrogate code units — charCodeAt sees each unit.
      const bucket = next() % 3;
      const unit = bucket === 0 ? next() % 0x80 : bucket === 1 ? next() % 0x10000 : 0xd800 + (next() % 0x800);
      str += String.fromCharCode(unit);
    }
    out.push(str);
  }
  return out;
}

describe('fnv1a64 (16-bit limbs) is bit-exact with the BigInt reference', () => {
  const fixed = [
    '',
    'a',
    'foobar',
    '{"a":1,"b":[true,null,"x"]}',
    'projected-tool-registry',
    'émoji 🚀 and 中文',
    '\u0000￿𐏿',
    'x'.repeat(10_000),
  ];

  it('matches known FNV-1a 64 test vectors', () => {
    // Published FNV-1a 64 vectors over ASCII bytes (identical to code units here).
    expect(fnv1a64BytesHex(new TextEncoder().encode(''))).toBe('cbf29ce484222325');
    expect(fnv1a64BytesHex(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a64BytesHex(new TextEncoder().encode('foobar'))).toBe('85944171f73967e8');
    expect(fnv1a64CodeUnitsBase36('foobar')).toBe(BigInt('0x85944171f73967e8').toString(36));
  });

  it('code-unit/base36 form matches on fixed and random inputs', () => {
    for (const str of [...fixed, ...randomStrings(400, 0x5eed)]) {
      expect(fnv1a64CodeUnitsBase36(str)).toBe(referenceCodeUnitsBase36(str));
    }
  });

  it('byte/hex form matches on fixed and random inputs', () => {
    const encoder = new TextEncoder();
    for (const str of [...fixed, ...randomStrings(400, 0xfeed)]) {
      const bytes = encoder.encode(str);
      expect(fnv1a64BytesHex(bytes)).toBe(referenceBytesHex(bytes));
    }
    const allBytes = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
    expect(fnv1a64BytesHex(allBytes)).toBe(referenceBytesHex(allBytes));
  });

  it('control: a deliberately wrong hash (dropped carry) is caught by the reference comparison', () => {
    // Guards the guard: if the comparison could not tell a broken variant apart,
    // the equality tests above would pass vacuously.
    function droppedCarry(str: string): string {
      let hi = 0xcbf29ce4;
      let lo = 0x84222325;
      for (let i = 0; i < str.length; i++) {
        lo = (lo ^ str.charCodeAt(i)) >>> 0;
        const t = lo * 0x1b3;
        hi = (hi * 0x1b3 + lo * 256) >>> 0; // carry omitted
        lo = t >>> 0;
      }
      return ((BigInt(hi) << 32n) | BigInt(lo)).toString(36);
    }
    const mismatches = randomStrings(50, 0xbad).filter(
      (str) => str.length > 2 && droppedCarry(str) !== referenceCodeUnitsBase36(str),
    );
    expect(mismatches.length).toBeGreaterThan(0);
  });
});
