/**
 * Tests for the pluggable schema→JSON-Schema adapter.
 * Run with: npx vitest run libs/generic/tooldef/src/schema-adapter.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  zodJsonSchemaAdapter,
  setJsonSchemaAdapter,
  toJsonSchema,
} from './schema-adapter';

// Reset to the shipped default (Zod) after each test so an override can't leak.
afterEach(() => setJsonSchemaAdapter(zodJsonSchemaAdapter));

describe('default (Zod) adapter', () => {
  it('converts a Zod object schema to a JSON Schema object', () => {
    const out = toJsonSchema(z.object({ slug: z.string(), count: z.number() }));
    expect(out.type).toBe('object');
    expect(out.properties).toMatchObject({
      slug: { type: 'string' },
      count: { type: 'number' },
    });
  });

  it('zodJsonSchemaAdapter is the active adapter by default', () => {
    const direct = zodJsonSchemaAdapter(z.object({ a: z.string() }));
    const viaActive = toJsonSchema(z.object({ a: z.string() }));
    expect(viaActive).toEqual(direct);
  });
});

describe('setJsonSchemaAdapter', () => {
  it('routes toJsonSchema through a host-registered adapter', () => {
    const sentinel = { type: 'object', 'x-custom': true } as Record<string, unknown>;
    setJsonSchemaAdapter(() => sentinel);
    expect(toJsonSchema(z.object({ anything: z.boolean() }))).toBe(sentinel);
  });

  it('is last-writer-wins', () => {
    setJsonSchemaAdapter(() => ({ which: 'first' }));
    setJsonSchemaAdapter(() => ({ which: 'second' }));
    expect(toJsonSchema(z.string())).toEqual({ which: 'second' });
  });
});
