import { describe, it, expect } from 'vitest';
import {
  parseDeltaRequest,
  formatDeltaRequest,
  encodeDeltaCursor,
  decodeDeltaCursor,
  computeViewFingerprint,
  negotiateDelta,
  computeRowDigest,
  computeViewChecksum,
  diffFromDigest,
  applySemanticDelta,
  deltaCounts,
  DELTA_MAX_DIGEST_ENTRIES,
  type DeltaCursorPayload,
  type DeltaChange,
} from './delta-protocol';

interface Row {
  id: string;
  name: string;
  rev: number;
}
const itemKey = (r: unknown) => (r as Row).id;
const rowRevision = (r: unknown) => (r as Row).rev;

describe('parseDeltaRequest', () => {
  it('returns undefined for absent / empty tokens', () => {
    expect(parseDeltaRequest(undefined)).toBeUndefined();
    expect(parseDeltaRequest(null)).toBeUndefined();
    expect(parseDeltaRequest('')).toBeUndefined();
    expect(parseDeltaRequest('   ')).toBeUndefined();
  });

  it('parses a bare mode', () => {
    expect(parseDeltaRequest('full')).toEqual({ mode: 'full' });
    expect(parseDeltaRequest('auto')).toEqual({ mode: 'auto' });
    expect(parseDeltaRequest('not_modified')).toEqual({ mode: 'not_modified' });
  });

  it('parses mode + cursor split on the first ~', () => {
    expect(parseDeltaRequest('not_modified~abc')).toEqual({ mode: 'not_modified', cursor: 'abc' });
    // base64url never contains ~, so the first ~ is unambiguous
    expect(parseDeltaRequest('auto~eyJ2IjoxfQ')).toEqual({ mode: 'auto', cursor: 'eyJ2IjoxfQ' });
  });

  it('coerces an unknown mode to auto (never throws)', () => {
    expect(parseDeltaRequest('garbage')).toEqual({ mode: 'auto' });
    expect(parseDeltaRequest('DELTA~xyz')).toEqual({ mode: 'auto', cursor: 'xyz' });
  });

  it('is case-insensitive on the mode and trims', () => {
    expect(parseDeltaRequest('  FULL  ')).toEqual({ mode: 'full' });
    expect(parseDeltaRequest('Not_Modified~c')).toEqual({ mode: 'not_modified', cursor: 'c' });
  });

  it('round-trips through formatDeltaRequest', () => {
    for (const tok of ['full', 'auto', 'not_modified', 'not_modified~abc', 'auto~Zm9v']) {
      const req = parseDeltaRequest(tok)!;
      expect(formatDeltaRequest(req)).toBe(tok);
    }
  });
});

describe('delta cursor encode/decode', () => {
  it('round-trips a payload', () => {
    const p: DeltaCursorPayload = { v: 1, fp: 'abc123', rev: '42', sv: 'v2' };
    const tok = encodeDeltaCursor(p);
    expect(decodeDeltaCursor(tok)).toEqual(p);
  });

  it('round-trips without an optional schemaVersion', () => {
    const p: DeltaCursorPayload = { v: 1, fp: 'fp', rev: 'r' };
    expect(decodeDeltaCursor(encodeDeltaCursor(p))).toEqual(p);
  });

  it('produces a url-safe token (no +, /, or = padding)', () => {
    const tok = encodeDeltaCursor({ v: 1, fp: 'a'.repeat(40), rev: 'b'.repeat(40), sv: 'schema/with+slash' });
    expect(tok).not.toMatch(/[+/=]/);
    expect(decodeDeltaCursor(tok)).toMatchObject({ sv: 'schema/with+slash' });
  });

  it('returns null (never throws) for malformed / invalid tokens', () => {
    expect(decodeDeltaCursor(undefined)).toBeNull();
    expect(decodeDeltaCursor(null)).toBeNull();
    expect(decodeDeltaCursor('')).toBeNull();
    expect(decodeDeltaCursor('!!!not base64!!!')).toBeNull();
    expect(decodeDeltaCursor(encodeDeltaCursor({ v: 2 as 1, fp: 'a', rev: 'b' }))).toBeNull(); // wrong version
    // valid base64url of non-cursor JSON
    expect(decodeDeltaCursor(Buffer.from('{"hello":1}').toString('base64url'))).toBeNull();
    expect(decodeDeltaCursor(Buffer.from('not json').toString('base64url'))).toBeNull();
  });
});

describe('computeViewFingerprint', () => {
  const base = { toolName: 'plans:attention', args: { harness: 'papercusp', limit: 20 }, scope: 'ws:h:role', format: 'compact' };

  it('is deterministic', () => {
    expect(computeViewFingerprint(base)).toBe(computeViewFingerprint(base));
  });

  it('is insensitive to object key order in args', () => {
    const reordered = { ...base, args: { limit: 20, harness: 'papercusp' } };
    expect(computeViewFingerprint(reordered)).toBe(computeViewFingerprint(base));
  });

  it('changes when the tool name changes', () => {
    expect(computeViewFingerprint({ ...base, toolName: 'plans:list' })).not.toBe(computeViewFingerprint(base));
  });

  it('changes when args change', () => {
    expect(computeViewFingerprint({ ...base, args: { harness: 'papercusp', limit: 21 } })).not.toBe(
      computeViewFingerprint(base),
    );
  });

  it('changes when scope changes (auth boundary)', () => {
    expect(computeViewFingerprint({ ...base, scope: 'other-ws:h:role' })).not.toBe(computeViewFingerprint(base));
  });

  it('changes when the requested format changes', () => {
    expect(computeViewFingerprint({ ...base, format: 'json' })).not.toBe(computeViewFingerprint(base));
  });

  it('treats missing scope/format as empty (stable)', () => {
    expect(computeViewFingerprint({ toolName: 't', args: { a: 1 } })).toBe(
      computeViewFingerprint({ toolName: 't', args: { a: 1 }, scope: '', format: '' }),
    );
  });
});

describe('negotiateDelta', () => {
  const fp = computeViewFingerprint({ toolName: 't', args: { a: 1 }, scope: 's', format: 'compact' });

  it('a non-capable endpoint always returns full, no cursor, supported:false', () => {
    const n = negotiateDelta({ request: parseDeltaRequest('not_modified~whatever'), capabilityDeclared: false });
    expect(n).toEqual({ mode: 'full', supported: false, reason: 'not_capable' });
    expect(n.cursor).toBeUndefined();
  });

  it('the small-response bypass returns full, no cursor, supported:true', () => {
    const n = negotiateDelta({ request: undefined, capabilityDeclared: true, bypass: true, currentRevision: '1', currentFingerprint: fp });
    expect(n).toEqual({ mode: 'full', supported: true, reason: 'bypass' });
    expect(n.cursor).toBeUndefined();
  });

  it('no _delta request → full + fresh cursor (capable endpoint)', () => {
    const n = negotiateDelta({ request: undefined, capabilityDeclared: true, currentRevision: '7', currentFingerprint: fp });
    expect(n.mode).toBe('full');
    expect(n.supported).toBe(true);
    expect(n.reason).toBe('no_request');
    const decoded = decodeDeltaCursor(n.cursor!);
    expect(decoded).toEqual({ v: 1, fp, rev: '7' });
  });

  it('mode=full → full + fresh cursor', () => {
    const n = negotiateDelta({ request: { mode: 'full' }, capabilityDeclared: true, currentRevision: '7', currentFingerprint: fp });
    expect(n.mode).toBe('full');
    expect(n.reason).toBe('requested_full');
    expect(n.cursor).toBeTruthy();
  });

  it('delta requested but no cursor (first call) → full + fresh cursor', () => {
    const n = negotiateDelta({ request: { mode: 'auto' }, capabilityDeclared: true, currentRevision: '7', currentFingerprint: fp });
    expect(n.mode).toBe('full');
    expect(n.reason).toBe('no_cursor');
    expect(decodeDeltaCursor(n.cursor!)?.rev).toBe('7');
  });

  it('a matching cursor on an UNCHANGED view → not_modified', () => {
    const first = negotiateDelta({ request: { mode: 'auto' }, capabilityDeclared: true, currentRevision: '7', currentFingerprint: fp });
    const second = negotiateDelta({
      request: { mode: 'not_modified', cursor: first.cursor },
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
    });
    expect(second.mode).toBe('not_modified');
    expect(second.supported).toBe(true);
    expect(second.reason).toBeUndefined();
    // still mints a fresh cursor for the next round
    expect(decodeDeltaCursor(second.cursor!)?.rev).toBe('7');
  });

  it('a cursor on a CHANGED view (revision advanced) → full + reason:changed', () => {
    const first = negotiateDelta({ request: { mode: 'auto' }, capabilityDeclared: true, currentRevision: '7', currentFingerprint: fp });
    const second = negotiateDelta({
      request: { mode: 'auto', cursor: first.cursor },
      capabilityDeclared: true,
      currentRevision: '8', // advanced
      currentFingerprint: fp,
    });
    expect(second.mode).toBe('full');
    expect(second.reason).toBe('changed');
    expect(decodeDeltaCursor(second.cursor!)?.rev).toBe('8');
  });

  it('a cursor from a DIFFERENT view (fingerprint mismatch) → full + reason:view_changed', () => {
    const otherFp = computeViewFingerprint({ toolName: 't', args: { a: 2 }, scope: 's', format: 'compact' });
    const stale = encodeDeltaCursor({ v: 1, fp: otherFp, rev: '7' });
    const n = negotiateDelta({
      request: { mode: 'not_modified', cursor: stale },
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
    });
    expect(n.mode).toBe('full');
    expect(n.reason).toBe('view_changed');
  });

  it('a cursor with a stale schemaVersion → full + reason:schema_changed', () => {
    const stale = encodeDeltaCursor({ v: 1, fp, rev: '7', sv: 'v1' });
    const n = negotiateDelta({
      request: { mode: 'not_modified', cursor: stale },
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
      schemaVersion: 'v2',
    });
    expect(n.mode).toBe('full');
    expect(n.reason).toBe('schema_changed');
    expect(decodeDeltaCursor(n.cursor!)?.sv).toBe('v2');
  });

  it('a malformed cursor → full + reason:cursor_malformed', () => {
    const n = negotiateDelta({
      request: { mode: 'not_modified', cursor: '!!!garbage!!!' },
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
    });
    expect(n.mode).toBe('full');
    expect(n.reason).toBe('cursor_malformed');
  });

  it('honors schemaVersion in the not_modified happy path', () => {
    const first = negotiateDelta({
      request: { mode: 'auto' },
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
      schemaVersion: 'v2',
    });
    const second = negotiateDelta({
      request: { mode: 'not_modified', cursor: first.cursor },
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
      schemaVersion: 'v2',
    });
    expect(second.mode).toBe('not_modified');
  });

  it('embeds a cursor digest + ts via cursorExtra and round-trips it', () => {
    const dg = { a: '1', b: '2' };
    const n = negotiateDelta({
      request: undefined,
      capabilityDeclared: true,
      currentRevision: '7',
      currentFingerprint: fp,
      cursorExtra: { dg, ts: 1000 },
    });
    const decoded = decodeDeltaCursor(n.cursor!);
    expect(decoded?.dg).toEqual(dg);
    expect(decoded?.ts).toBe(1000);
  });
});

describe('computeRowDigest', () => {
  const rows: Row[] = [
    { id: 'a', name: 'A', rev: 1 },
    { id: 'b', name: 'B', rev: 1 },
  ];

  it('maps itemKey → rowRevision', () => {
    expect(computeRowDigest(rows, itemKey, rowRevision)).toEqual({ a: '1', b: '1' });
  });

  it('falls back to a content hash when no rowRevision is given (still detects updates)', () => {
    const d1 = computeRowDigest(rows, itemKey)!;
    const d2 = computeRowDigest([{ id: 'a', name: 'A', rev: 1 }, { id: 'b', name: 'B-changed', rev: 1 }], itemKey)!;
    expect(d1.a).toBe(d2.a); // unchanged row → same hash
    expect(d1.b).not.toBe(d2.b); // changed content → different hash even though rev is equal
  });

  it('returns null above DELTA_MAX_DIGEST_ENTRIES (caller omits the digest)', () => {
    const big = Array.from({ length: DELTA_MAX_DIGEST_ENTRIES + 1 }, (_, i) => ({ id: `r${i}`, name: 'x', rev: 1 }));
    expect(computeRowDigest(big, itemKey, rowRevision)).toBeNull();
  });
});

describe('computeViewChecksum', () => {
  const rows: Row[] = [
    { id: 'a', name: 'A', rev: 1 },
    { id: 'b', name: 'B', rev: 2 },
  ];

  it('is deterministic and order-insensitive', () => {
    expect(computeViewChecksum(rows, itemKey, rowRevision)).toBe(
      computeViewChecksum([...rows].reverse(), itemKey, rowRevision),
    );
  });

  it('changes when a row revision changes / a row is added / a row is removed', () => {
    const base = computeViewChecksum(rows, itemKey, rowRevision);
    expect(computeViewChecksum([{ id: 'a', name: 'A', rev: 9 }, rows[1]], itemKey, rowRevision)).not.toBe(base);
    expect(computeViewChecksum([...rows, { id: 'c', name: 'C', rev: 1 }], itemKey, rowRevision)).not.toBe(base);
    expect(computeViewChecksum([rows[0]], itemKey, rowRevision)).not.toBe(base);
  });
});

describe('diffFromDigest', () => {
  const prior: Row[] = [
    { id: 'a', name: 'A', rev: 1 },
    { id: 'b', name: 'B', rev: 1 },
    { id: 'c', name: 'C', rev: 1 },
  ];
  const priorDigest = computeRowDigest(prior, itemKey, rowRevision)!;

  it('detects added / updated / removed (and omits unchanged)', () => {
    const next: Row[] = [
      { id: 'a', name: 'A', rev: 1 }, // unchanged
      { id: 'b', name: 'B2', rev: 2 }, // updated (rev bumped)
      { id: 'd', name: 'D', rev: 1 }, // added
      // c removed
    ];
    const changes = diffFromDigest(priorDigest, next, itemKey, { rowRevision });
    expect(deltaCounts(changes)).toEqual({ added: 1, updated: 1, removed: 1 });
    const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
    expect(byId.d.change).toBe('added');
    expect(byId.d.data).toEqual({ id: 'd', name: 'D', rev: 1 });
    expect(byId.b.change).toBe('updated');
    expect(byId.c.change).toBe('removed');
    expect(byId.c.data).toBeUndefined(); // removed carries id only
    expect(byId.a).toBeUndefined(); // unchanged omitted
  });

  it('tags rows with rowType when provided', () => {
    const changes = diffFromDigest(priorDigest, [{ id: 'e', name: 'E', rev: 1 }], itemKey, {
      rowRevision,
      rowType: () => 'plan-item',
    });
    expect(changes.find((c) => c.id === 'e')?.type).toBe('plan-item');
  });
});

describe('applySemanticDelta — merge-correctness (the D-008 de-risk property)', () => {
  it('applying diff(base→next) to base reconstructs next exactly (set-wise)', () => {
    const base: Row[] = [
      { id: 'a', name: 'A', rev: 1 },
      { id: 'b', name: 'B', rev: 1 },
      { id: 'c', name: 'C', rev: 1 },
    ];
    const next: Row[] = [
      { id: 'a', name: 'A', rev: 1 }, // unchanged
      { id: 'b', name: 'B2', rev: 2 }, // updated
      { id: 'd', name: 'D', rev: 1 }, // added
      // c removed
    ];
    const digest = computeRowDigest(base, itemKey, rowRevision)!;
    const changes = diffFromDigest(digest, next, itemKey, { rowRevision }) as DeltaChange<Row>[];
    const merged = applySemanticDelta(base, changes, (r) => r.id);
    // set-wise equality + the post-merge checksum matches the fresh full view
    const sortById = (rs: Row[]) => [...rs].sort((x, y) => x.id.localeCompare(y.id));
    expect(sortById(merged)).toEqual(sortById(next));
    expect(computeViewChecksum(merged, itemKey, rowRevision)).toBe(computeViewChecksum(next, itemKey, rowRevision));
  });

  it('a no-op delta (no changes) leaves the base identical', () => {
    const base: Row[] = [{ id: 'a', name: 'A', rev: 1 }];
    const digest = computeRowDigest(base, itemKey, rowRevision)!;
    const changes = diffFromDigest(digest, base, itemKey, { rowRevision });
    expect(changes).toEqual([]);
    expect(applySemanticDelta(base, changes as DeltaChange<Row>[], (r) => r.id)).toEqual(base);
  });
});
