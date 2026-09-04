import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flattenForOpenAi, toArgsJsonSchema } from './define-tool';

describe('flattenForOpenAi', () => {
  it('does not let a never branch mask the valid resume/successor fields', () => {
    const base = z.object({
      brief: z.string().optional(),
      plan: z.string().optional(),
      resume: z
        .object({ agentId: z.string().optional(), sessionId: z.string().optional() })
        .optional(),
      successor: z
        .object({ agentId: z.string().optional(), sessionId: z.string().optional() })
        .optional(),
    });
    const schema = z.union([
      base.extend({ resume: z.never().optional(), successor: z.never().optional() }),
      base.extend({ plan: z.never().optional() }),
    ]);

    const flattened = flattenForOpenAi(toArgsJsonSchema('test:resume', schema));
    const properties = flattened.properties as Record<string, Record<string, unknown>>;

    expect(properties.resume).toMatchObject({ type: 'object' });
    expect(properties.successor).toMatchObject({ type: 'object' });
    expect(properties.plan).toMatchObject({ type: 'string' });
  });

  it('keeps first-declaration-wins for two satisfiable definitions', () => {
    const flattened = flattenForOpenAi({
      anyOf: [
        { type: 'object', properties: { value: { type: 'string' } } },
        { type: 'object', properties: { value: { type: 'number' } } },
      ],
    });

    expect(flattened.properties).toEqual({ value: { type: 'string' } });
  });

  it('unions a discriminated-union discriminator into an enum instead of collapsing to the first branch', () => {
    // EI-21914494224354098: release:repair-queue's `op: z.discriminatedUnion('op', [get, converge, retire])`
    // flattened to `op: { const: 'get' }` — hiding 'converge'/'retire' from every caller reading the schema.
    const schema = z.discriminatedUnion('op', [
      z.object({ op: z.literal('get') }),
      z.object({ op: z.literal('converge'), confirm: z.boolean().optional() }),
      z.object({ op: z.literal('retire'), reason: z.string() }),
    ]);

    const flattened = flattenForOpenAi(toArgsJsonSchema('test:op', schema));
    const properties = flattened.properties as Record<string, Record<string, unknown>>;

    expect(properties.op).toEqual({ type: 'string', enum: ['get', 'converge', 'retire'] });
    expect(flattened.required).toEqual(['op']);
  });

  it('leaves a single-valued const field alone (no spurious enum wrapping)', () => {
    const schema = z.union([
      z.object({ mode: z.literal('a'), extra: z.string().optional() }),
      z.object({ mode: z.literal('a'), other: z.number().optional() }),
    ]);

    const flattened = flattenForOpenAi(toArgsJsonSchema('test:same-const', schema));
    const properties = flattened.properties as Record<string, Record<string, unknown>>;

    expect(properties.mode).toEqual({ const: 'a', type: 'string' });
  });

  it('does not classify a constrained not schema as never', () => {
    const flattened = flattenForOpenAi({
      anyOf: [
        { type: 'object', properties: { value: { not: { type: 'string' } } } },
        { type: 'object', properties: { value: { type: 'number' } } },
      ],
    });

    expect(flattened.properties).toEqual({ value: { not: { type: 'string' } } });
  });
});
