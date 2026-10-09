import {
  closeOrchestrationKernel,
  inspectOrchestrationKernel,
  openOrchestrationKernel,
  runOrchestrationScript,
} from '../run-script.ts';
import type { ToolFacade } from '../tool-facade.ts';

// This fixture deliberately has no owner relay: it measures the production
// runtime's process boundary, independently of transport affinity claims.
const held = new Map<string, string>();
process.on('message', async (message: unknown) => {
  const request = message as { seq: number; op: string; scope: string; id?: string; script?: string };
  try {
    let result: unknown;
    if (request.op === 'open') {
      const kernel = await openOrchestrationKernel(request.scope);
      held.set(kernel.id, request.scope);
      result = kernel;
    } else if (request.op === 'run') {
      result = await runOrchestrationScript(request.script!, {} as ToolFacade, {
        kernel: { id: request.id!, scope: request.scope }, timeoutMs: 5_000,
      });
    } else if (request.op === 'close') {
      result = closeOrchestrationKernel(request.id!, request.scope);
    } else {
      result = inspectOrchestrationKernel(request.id!, request.scope);
    }
    process.send?.({ seq: request.seq, result, pid: process.pid });
  } catch (error) {
    process.send?.({ seq: request.seq, error: String(error), pid: process.pid });
  }
});
process.on('disconnect', () => {
  for (const [id, scope] of held) closeOrchestrationKernel(id, scope);
  process.exit(0);
});
process.send?.({ ready: true, pid: process.pid });
