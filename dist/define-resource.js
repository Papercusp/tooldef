"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineResource = defineResource;
const capability_tiers_1 = require("./capability-tiers");
const resource_registry_1 = require("./resource-registry");
function deriveNameFromCallSite() {
    const ErrorAny = Error;
    const orig = ErrorAny.prepareStackTrace;
    try {
        ErrorAny.prepareStackTrace = (_err, stack) => stack;
        const raw = new Error().stack;
        // [0]=this fn, [1]=defineResource, [2]=caller (the resource file).
        const callerFile = raw?.[2]?.getFileName?.();
        if (!callerFile)
            return null;
        const match = /\/resources\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(callerFile);
        if (!match)
            return null;
        const group = match[1];
        let verb = match[2];
        if (verb === 'index')
            verb = 'default';
        return `${group}:${verb}`;
    }
    catch {
        return null;
    }
    finally {
        ErrorAny.prepareStackTrace = orig;
    }
}
function defineResource(input) {
    const name = input.name ?? deriveNameFromCallSite();
    if (!name) {
        throw new Error('defineResource: could not derive name from call site. ' +
            'Pass `name` explicitly or place the file under `resources/<group>/<verb>.ts`.');
    }
    const description = input.description ?? `Resource ${name}`;
    const tier = (0, capability_tiers_1.tierFor)(input.capability);
    const def = {
        uri: input.uri,
        name,
        description,
        mimeType: input.mimeType ?? 'application/json',
        capability: input.capability,
        tier,
        list: input.list,
        read: input.read,
    };
    (0, resource_registry_1.registerResource)(def);
    return def;
}
