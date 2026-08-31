import { describe, it, expect } from 'vitest';
import { generateToolFacadeTypes, listFacadeNamespaces, toolArgsType, toolResultType, } from './facade-types';
/**
 * Minimal ProjectedTool stand-in — facade-types reads only expose.mcp.name, description, and
 * inputSchema (the projected JSON Schema). The inputSchema shapes mirror real Zod-4
 * `z.toJSONSchema` output (object + properties + required, enums, arrays, nested objects,
 * anyOf, record/additionalProperties).
 */
function mkTool(name, inputSchema, description = '', opts) {
    return {
        expose: { mcp: { name } },
        description,
        inputSchema,
        outputJsonSchema: opts?.outputJsonSchema,
        guidance: opts?.returns ? { returns: opts.returns } : undefined,
    };
}
const workItemsList = mkTool('work_items:list', {
    type: 'object',
    properties: {
        status: { description: 'lifecycle state', type: 'string', enum: ['open', 'closed'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        name: { type: 'string', minLength: 1 },
        tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
    additionalProperties: false,
}, 'List work-items across kinds (feature/bug/change).');
const coordWakeQueue = mkTool('coord:wake-queue', { type: 'object', properties: {}, additionalProperties: false }, 'Review a manual-mode agent staged wakes.');
const plansSetStatus = mkTool('plans:set-status', {
    type: 'object',
    properties: {
        slug: { type: 'string' },
        itemId: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'wip', 'done'] },
    },
    required: ['slug', 'itemId', 'status'],
    additionalProperties: false,
}, 'Flip one item stored status.');
const nestedTool = mkTool('demo:nested', {
    type: 'object',
    properties: {
        nested: {
            type: 'object',
            properties: { id: { type: 'string' }, n: { type: 'number' } },
            required: ['id', 'n'],
            additionalProperties: false,
        },
        anyOfField: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        rec: { type: 'object', additionalProperties: { type: 'number' } },
    },
    required: ['nested'],
    additionalProperties: false,
}, 'Demo nested/anyOf/record shapes.');
const systemAdmin = mkTool('system:admin', { type: 'object', properties: {} }, 'danger');
const all = [workItemsList, coordWakeQueue, plansSetStatus, nestedTool, systemAdmin];
describe('facade-types (B-CX-API)', () => {
    it('generates a declare const tools block with namespaced typed signatures', () => {
        const out = generateToolFacadeTypes([workItemsList]);
        expect(out).toContain('declare const tools: {');
        expect(out).toContain('workItems: {');
        // required `name` has NO `?`; optionals have `?`; enum → literal union; array → Array<string>.
        expect(out).toMatch(/list\(args: \{ status\?: "open" \| "closed"; limit\?: number; name: string; tags\?: Array<string> \}\): Promise<unknown>;/);
        // The tool description rides as a JSDoc comment.
        expect(out).toContain('/** List work-items across kinds (feature/bug/change). */');
        // Property descriptions survive the signature projection as actionable @param hints.
        expect(out).toContain('/** @param args.status lifecycle state */');
    });
    it('always includes the call() escape hatch', () => {
        const out = generateToolFacadeTypes([workItemsList]);
        expect(out).toContain('call(toolName: string, args?: unknown): Promise<unknown>;');
    });
    it('camelCases hyphenated verbs to match the runtime facade, and marks empty args optional', () => {
        const out = generateToolFacadeTypes([coordWakeQueue]);
        // coord:wake-queue → wakeQueue; empty object args → args?: {}
        expect(out).toContain('wakeQueue(args?: {}): Promise<unknown>;');
    });
    it('marks args required-less calls as args? and all-required calls without ?', () => {
        const optionalCall = toolArgsType(workItemsList); // has required: ['name']
        expect(optionalCall.optional).toBe(false);
        const setStatus = generateToolFacadeTypes([plansSetStatus]);
        // every field required → no `?` on args and no `?` on fields
        expect(setStatus).toMatch(/setStatus\(args: \{ slug: string; itemId: string; status: "todo" \| "wip" \| "done" \}\): Promise<unknown>;/);
    });
    it('renders nested objects, anyOf unions, and record/additionalProperties shapes', () => {
        const t = toolArgsType(nestedTool).type;
        expect(t).toContain('nested: { id: string; n: number }');
        expect(t).toContain('anyOfField?: string | number');
        expect(t).toContain('rec?: Record<string, number>');
    });
    it('scopes to the allowed set — tools outside the envelope are omitted', () => {
        const out = generateToolFacadeTypes(all, { allowed: new Set(['work_items:list']) });
        expect(out).toContain('workItems: {');
        expect(out).not.toContain('system:');
        expect(out).not.toContain('admin(');
        expect(out).not.toContain('plans: {');
    });
    it('filters to requested namespaces (on-demand discovery)', () => {
        const out = generateToolFacadeTypes(all, { namespaces: ['plans'] });
        expect(out).toContain('plans: {');
        expect(out).toContain('setStatus(');
        expect(out).not.toContain('work_items: {');
        expect(out).not.toContain('demo: {');
        // escape hatch still present
        expect(out).toContain('call(toolName: string');
    });
    it('filters to requested exact tool names (union with namespaces)', () => {
        const out = generateToolFacadeTypes(all, { names: ['work_items:list'] });
        expect(out).toContain('workItems: {');
        expect(out).toContain('list(');
        expect(out).not.toContain('plans: {');
    });
    it('lists the namespace index for cheap on-demand discovery', () => {
        const idx = listFacadeNamespaces(all, new Set(['work_items:list', 'plans:set-status']));
        const byNs = Object.fromEntries(idx.map((e) => [e.ns, e]));
        expect(Object.keys(byNs).sort()).toEqual(['plans', 'workItems']);
        expect(byNs.workItems.verbs).toEqual(['list']);
        expect(byNs.workItems.toolNames).toEqual(['work_items:list']);
        expect(byNs.plans.verbs).toEqual(['setStatus']);
    });
    it('falls back to Record<string, unknown> for a missing/odd inputSchema', () => {
        const odd = { expose: { mcp: { name: 'x:y' } }, description: '' };
        const { type, optional } = toolArgsType(odd);
        expect(type).toBe('Record<string, unknown>');
        expect(optional).toBe(true);
    });
    it('preserves units from a capability timeout property in the code:tools signature', () => {
        const capabilityBash = mkTool('capability:bash', {
            type: 'object',
            properties: {
                timeout: {
                    type: 'integer',
                    description: 'Wall-clock timeout in milliseconds; 20 seconds = 20000.',
                },
            },
            additionalProperties: false,
        }, 'Run bash commands.');
        const out = generateToolFacadeTypes([capabilityBash]);
        expect(out).toContain('/** @param args.timeout Wall-clock timeout in milliseconds; 20 seconds = 20000. */');
        expect(out).toContain('bash(args?: { timeout?: number }): Promise<unknown>;');
    });
    it('emits balanced, well-formed TS (braces match)', () => {
        const out = generateToolFacadeTypes(all);
        const opens = (out.match(/\{/g) ?? []).length;
        const closes = (out.match(/\}/g) ?? []).length;
        expect(opens).toBe(closes);
        expect(out.trimEnd().endsWith('};')).toBe(true);
    });
    // EI-18683272396981279: a plugin-namespaced tool projects its MCP name with a DOT
    // (`gitnexus.query`), not the canonical colon (`ns:verb`) — the compile-time signature
    // generator used the same colon-only shape check the runtime facade did, so a plugin tool
    // never got a rendered signature at all even when `allowed` already included it.
    describe('dot-form (plugin-namespaced) tool names (EI-18683272396981279)', () => {
        const gitnexusQuery = mkTool('gitnexus.query', { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }, 'Query the code call graph.');
        it('renders a typed signature for a dot-form tool under tools.<ns>.<verb>', () => {
            const out = generateToolFacadeTypes([gitnexusQuery]);
            expect(out).toContain('gitnexus: {');
            expect(out).toMatch(/query\(args: \{ pattern: string \}\): Promise<unknown>;/);
            expect(out).toContain('/** Query the code call graph. */');
        });
        it('scopes to the allowed set for dot-form names too (no bypass)', () => {
            const out = generateToolFacadeTypes([gitnexusQuery, workItemsList], {
                allowed: new Set(['work_items:list']),
            });
            expect(out).not.toContain('gitnexus:');
            expect(out).toContain('workItems: {');
        });
        it('lists a dot-form tool in the namespace index', () => {
            const idx = listFacadeNamespaces([gitnexusQuery], new Set(['gitnexus.query']));
            const byNs = Object.fromEntries(idx.map((e) => [e.ns, e]));
            expect(byNs.gitnexus.verbs).toEqual(['query']);
            expect(byNs.gitnexus.toolNames).toEqual(['gitnexus.query']);
        });
    });
    // EI-13298: render the RETURN shape, not just the args — a code:run script author who
    // never sees a return type guesses response keys, and a wrong-key guess fails silently
    // (an empty/undefined result that reads as a true negative, not the mapping bug it is).
    describe('return-shape rendering (EI-13298)', () => {
        const workItemsGet = mkTool('work_items:get', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, 'Fetch one work-item.', {
            outputJsonSchema: {
                type: 'object',
                properties: {
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                workItem: {
                                    type: 'object',
                                    properties: { id: { type: 'string' }, state: { type: 'string' } },
                                    required: ['id', 'state'],
                                },
                            },
                            required: ['workItem'],
                        },
                    },
                },
                required: ['results'],
            },
        });
        const coordPresence = mkTool('coord:presence', { type: 'object', properties: {} }, 'List coordination agents.', {
            returns: '{ summary: { active: number }, active: AgentRow[] (the roster — NOT `agents`/`presence`) }',
        });
        it('toolResultType renders the declared outputJsonSchema to a TS type', () => {
            expect(toolResultType(workItemsGet)).toBe('{ results: Array<{ workItem: { id: string; state: string } }> }');
        });
        it('falls back to `unknown` when no outputJsonSchema is declared', () => {
            expect(toolResultType(coordPresence)).toBe('unknown');
        });
        it('generateToolFacadeTypes emits the real Promise<...> type when an output schema exists', () => {
            const out = generateToolFacadeTypes([workItemsGet]);
            expect(out).toContain('get(args: { id: string }): Promise<{ results: Array<{ workItem: { id: string; state: string } }> }>;');
        });
        it('generateToolFacadeTypes emits an @returns comment from guidance.returns when no schema exists', () => {
            const out = generateToolFacadeTypes([coordPresence]);
            expect(out).toContain('/** @returns { summary: { active: number }, active: AgentRow[] (the roster — NOT `agents`/`presence`) } */');
            // No declared schema ⇒ honest `unknown`, never a made-up type.
            expect(out).toMatch(/presence\(args\?: Record<string, unknown>\): Promise<unknown>;/);
        });
        it('a tool with neither an output schema nor guidance.returns still renders Promise<unknown> and no @returns line', () => {
            const out = generateToolFacadeTypes([workItemsList]);
            expect(out).toContain('list(args: { status?: "open" | "closed"; limit?: number; name: string; tags?: Array<string> }): Promise<unknown>;');
            expect(out).not.toContain('@returns');
        });
    });
});
