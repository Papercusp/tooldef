/**
 * defineResource — symmetric to defineTool.
 *
 * Resources are declared via `defineResource({ uri, capability, read, list? })`
 * and placed in `src/resources/<group>/<verb>.ts`. The helper:
 *   - Derives the resource name from the file path:
 *     `resources/harness/list.ts` → `harness:list`. Override via `name`.
 *   - Looks up the tier from the capability per §10.6.1.
 *   - Self-registers into `resource-registry.ts`.
 *
 * The catalog is the result of importing `resources/**`.
 */
import type { ResourceDefinition, ResourceDefinitionInput } from './types';
export declare function defineResource(input: ResourceDefinitionInput): ResourceDefinition;
