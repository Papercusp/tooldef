import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetWorkspaceLifecycleForTests,
  _subscriberCountForTests,
  dispatchWorkspaceSwitch,
  onWorkspaceSwitch,
} from './workspace-lifecycle';

describe('workspace-lifecycle', () => {
  beforeEach(() => _resetWorkspaceLifecycleForTests());
  afterEach(() => _resetWorkspaceLifecycleForTests());

  it('subscribe + dispatch invokes all subscribers with the workspaceId', async () => {
    const a = vi.fn();
    const b = vi.fn();
    onWorkspaceSwitch(a);
    onWorkspaceSwitch(b);

    await dispatchWorkspaceSwitch('ws-123');

    expect(a).toHaveBeenCalledWith('ws-123');
    expect(b).toHaveBeenCalledWith('ws-123');
  });

  it('unsubscribe removes the callback', async () => {
    const a = vi.fn();
    const off = onWorkspaceSwitch(a);
    off();
    await dispatchWorkspaceSwitch('ws-x');
    expect(a).not.toHaveBeenCalled();
    expect(_subscriberCountForTests()).toBe(0);
  });

  it('one subscriber throwing does not block the others', async () => {
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    onWorkspaceSwitch(a);
    onWorkspaceSwitch(b);
    await dispatchWorkspaceSwitch('ws-1');

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('awaits async subscribers before resolving', async () => {
    const order: string[] = [];
    onWorkspaceSwitch(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('a');
    });
    onWorkspaceSwitch(() => {
      order.push('b');
    });

    await dispatchWorkspaceSwitch('ws-1');
    expect(order).toEqual(['a', 'b']);
  });

  it('dispatch with no subscribers is a no-op', async () => {
    await expect(dispatchWorkspaceSwitch('ws-empty')).resolves.toBeUndefined();
  });
});
