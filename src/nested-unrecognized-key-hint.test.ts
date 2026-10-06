import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toArgsJsonSchema, unknownArgHint } from './define-tool';

/**
 * EI-25240542476501298: a key rejected inside a NESTED object must not be reported as a
 * stray top-level arg. Two things hid its location, and this file pins both:
 *
 *  1. A union whose schema AUTHORS its own error message (work_items:complete lifts the
 *     nested unrecognized-key text into the union message) leaves only the union node —
 *     at the root — for the location-aware helpers to read.
 *  2. A reused sub-schema is emitted as a local `$ref` into `$defs`, and the schema walk
 *     did not follow refs, so no path through it resolved.
 *
 * Together they produced "this tool accepts ONLY: <top-level keys> … Re-send using only
 * the keys above" for a call whose top-level keys were all valid.
 */
const entry = z.object({ requirement: z.string(), disposition: z.enum(['implemented', 'deferred']) }).strict();
const shared = z
  .object({ summary: z.string(), verification: z.object({ dispositions: z.array(entry) }).strict().optional() })
  .strict()
  // A registry id makes zod emit this as `$ref` into `$defs` (it otherwise inlines reuse),
  // which is the shape work_items:complete's `completion` actually has.
  .meta({ id: 'EI25240542476501298SharedCompletion' });

function authoredUnrecognizedMessage(issue: unknown): string {
  // Mirrors complete.ts: lift the first nested unrecognized-key diagnosis, path-prefixed.
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      for (const nested of value) {
        const found = walk(nested);
        if (found) return found;
      }
      return undefined;
    }
    const rec = value as { code?: unknown; message?: unknown; path?: unknown[]; errors?: unknown };
    if (rec.code === 'unrecognized_keys' && typeof rec.message === 'string') {
      return rec.path?.length ? `${rec.path.join('.')}: ${rec.message}` : rec.message;
    }
    return walk(rec.errors);
  };
  return walk(issue) ?? 'Invalid input';
}

const schema = z.union(
  [
    z.object({ id: z.string(), completion: shared, items: z.never().optional() }).strict(),
    z.object({ items: z.array(z.object({ id: z.string(), completion: shared }).strict()) }).strict(),
  ],
  { error: (issue) => ({ message: authoredUnrecognizedMessage(issue) }) },
);

function hintFor(input: unknown): string {
  const parsed = schema.safeParse(input);
  expect(parsed.success).toBe(false);
  return unknownArgHint(parsed.error!.issues as never, toArgsJsonSchema('test:complete', schema), undefined, input, 'test:complete');
}

describe('unknownArgHint — nested unrecognized key behind an authored union message (EI-25240542476501298)', () => {
  it('the fixture really emits `completion` as a $ref (otherwise the ref leg below is untested)', () => {
    const json = JSON.stringify(toArgsJsonSchema('test:complete', schema));
    expect(json).toContain('"$ref"');
  });

  it('names the nested object and ITS accepted keys, not the top-level list', () => {
    const hint = hintFor({
      id: 'x',
      completion: { summary: 's', verification: { dispositions: [{ requirement: 'r', disposition: 'implemented', bogus: 1 }] } },
    });
    expect(hint).toContain('`bogus` was rejected inside `completion.verification.dispositions[]`');
    expect(hint).toContain('that object accepts ONLY: requirement, disposition');
    expect(hint).not.toContain('this tool accepts ONLY');
    expect(hint).not.toContain('Re-send using only the keys above');
  });

  it('suggests the relocation when the key exists one level deeper', () => {
    const hint = hintFor({ id: 'x', completion: { summary: 's', dispositions: [] } });
    expect(hint).toContain('`dispositions` was rejected inside `completion`');
    expect(hint).toContain('did you mean `completion.verification.dispositions`?');
  });

  it('calibration: a genuine stray TOP-LEVEL key still gets the top-level list', () => {
    const hint = hintFor({ id: 'x', completion: { summary: 's' }, strayTop: 1 });
    expect(hint).toContain('this tool accepts ONLY:');
    expect(hint).not.toContain('was rejected inside');
  });
});
