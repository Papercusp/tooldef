import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Cross-process lifetimes belong to the maintained integration layer; the
// repository test router discovers this config and records its verdict.
export default defineVitestConfig({ layer: 'integration' });
