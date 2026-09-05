import { describe, expect, it, vi } from 'vitest';
import {
  KernelEnforcementDeniedError,
  appliedExecutionRevision,
  enforceKernelBoundary,
  evaluateKernelEnforcement,
  kernelRevisionKey,
  normalizeKernelEnforcementResult,
  sameKernelRevision,
  wrapKernelSpawn,
  type KernelEnforcementRequest,
} from './kernel-enforcement';

const revision = { specificationRevision: 'spec-a', stateRevision: 'state-1' };

const request = (over: Partial<KernelEnforcementRequest> = {}): KernelEnforcementRequest => ({
  phase: 'preflight',
  boundary: 'dispatch',
  toolName: 'fixture:write',
  capabilities: ['fixture:write'],
  args: { id: 'x' },
  ctx: {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
  },
  ...over,
});

describe('kernel-enforcement contract', () => {
  it('normalizes absent or malformed optional policy to an unavailable allow', () => {
    expect(normalizeKernelEnforcementResult(null, 'preflight')).toMatchObject({
      decision: 'allow',
      availability: 'unavailable',
      applied: false,
    });
    expect(normalizeKernelEnforcementResult({ decision: 'not-a-decision' as never }, 'preflight').decision).toBe('allow');
  });

  it('preserves an explicit deny and its reason', async () => {
    const result = await evaluateKernelEnforcement(
      () => ({ decision: 'deny', code: 'revoked', reason: 'authority revoked' }),
      request(),
    );
    expect(result).toMatchObject({ decision: 'deny', code: 'revoked', reason: 'authority revoked' });
  });

  it('fails soft only when the optional port throws', async () => {
    const result = await evaluateKernelEnforcement(() => {
      throw new Error('state unavailable');
    }, request());
    expect(result.decision).toBe('allow');
    expect(result.availability).toBe('unavailable');
  });

  it('accepts execution attribution only from an applied enforce result', () => {
    expect(appliedExecutionRevision({ executionRevision: revision, revisionSource: 'desired', decision: 'allow' })).toBeNull();
    expect(appliedExecutionRevision({ executionRevision: revision, revisionSource: 'applied', decision: 'allow' })).toEqual(revision);
    expect(appliedExecutionRevision({ executionRevision: revision, revisionSource: 'applied', decision: 'allow' }, 'preflight')).toBeNull();
  });

  it('denies before invoking a native/shell operation', async () => {
    const operation = vi.fn(() => 'ran');
    await expect(
      enforceKernelBoundary(
        () => ({ decision: 'deny', code: 'stale-activation', reason: 'stale' }),
        request({ phase: 'enforce', boundary: 'shell' }),
        operation,
      ),
    ).rejects.toBeInstanceOf(KernelEnforcementDeniedError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('wraps a subprocess executor at the shell boundary', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', killed: false }));
    const wrapped = wrapKernelSpawn(
      spawn,
      (input) => ({ ...input, decision: 'allow' }),
      (bin, args) => request({ toolName: 'capability:bash', boundary: 'shell', operation: `${bin} ${args.join(' ')}` }),
    );
    await expect(wrapped('echo', ['ok'])).resolves.toMatchObject({ code: 0 });
    expect(spawn).toHaveBeenCalledWith('echo', ['ok'], undefined);
  });

  it('provides stable revision equality and keys', () => {
    expect(sameKernelRevision(revision, { ...revision })).toBe(true);
    expect(sameKernelRevision(revision, { ...revision, stateRevision: 'state-2' })).toBe(false);
    expect(kernelRevisionKey(revision)).toBe('spec-a:state-1');
    expect(kernelRevisionKey(null)).toBeNull();
  });
});
