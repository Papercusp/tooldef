import { describe, it, expect } from 'vitest';
describe('@papercusp/tooldef wire types', () => {
    it('ToolResult accepts the MCP content shapes', () => {
        const r = {
            content: [
                { type: 'text', text: 'hi' },
                { type: 'image', data: 'YWJj', mimeType: 'image/png' },
                { type: 'resource', resource: { uri: 'file:///x', text: 'x' } },
            ],
            isError: false,
            outputRef: '/scratch/out.txt',
            outputSize: 3,
        };
        expect(r.content).toHaveLength(3);
        expect(r.content[0]).toMatchObject({ type: 'text', text: 'hi' });
    });
    it('RolesQuota carries the three window caps', () => {
        const q = { perChunk: 1, perRun: 5, perDay: 100 };
        expect(q.perRun).toBe(5);
    });
    it('ProgressCallback / EmitCallback are callable with the documented args', () => {
        const seen = [];
        const progress = (pct, msg) => seen.push(['progress', { pct, msg }]);
        const emit = (name, data) => seen.push([name, data]);
        progress(50, 'half');
        progress(undefined);
        emit('delta', { text: 'tok' });
        expect(seen).toHaveLength(3);
        expect(seen[2]).toEqual(['delta', { text: 'tok' }]);
    });
});
