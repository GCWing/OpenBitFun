import { afterEach, describe, expect, it } from 'vitest';
import { resetWorkspaceDisplayOrdersForTest, setWorkspaceDisplayOrder, stableWorkspaceOrder } from './workspaceDisplayOrder';

const list = (...ids: string[]) => ids.map(id => ({ id }));
const ids = (items: Array<{ id: string }>) => items.map(item => item.id);

describe('stableWorkspaceOrder', () => {
  afterEach(resetWorkspaceDisplayOrdersForTest);

  it('keeps the shown order when an older host moves the active workspace to the front', () => {
    expect(ids(stableWorkspaceOrder('peer', list('openbitfun', 'repos')))).toEqual(['openbitfun', 'repos']);
    // Activating repos on the host reordered its list.
    expect(ids(stableWorkspaceOrder('peer', list('repos', 'openbitfun')))).toEqual(['openbitfun', 'repos']);
  });

  it('places a new workspace where the host put it and drops closed ones', () => {
    stableWorkspaceOrder('peer', list('a', 'b', 'c'));
    expect(ids(stableWorkspaceOrder('peer', list('new', 'c', 'a')))).toEqual(['new', 'a', 'c']);
  });

  it('keeps devices independent and lets an explicit reorder replace the order', () => {
    stableWorkspaceOrder('local', list('a', 'b'));
    stableWorkspaceOrder('peer', list('b', 'a'));
    setWorkspaceDisplayOrder('local', ['b', 'a']);
    expect(ids(stableWorkspaceOrder('local', list('a', 'b')))).toEqual(['b', 'a']);
    expect(ids(stableWorkspaceOrder('peer', list('a', 'b')))).toEqual(['b', 'a']);
  });

  it('adopts an order the host was arranged into on purpose', () => {
    stableWorkspaceOrder('peer', list('a', 'b', 'c', 'd'));
    // Another controller reordered the host: more than a move to the front.
    expect(ids(stableWorkspaceOrder('peer', list('b', 'a', 'd', 'c')))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(stableWorkspaceOrder('peer', list('c', 'b', 'a', 'd')))).toEqual(['b', 'a', 'd', 'c']);
  });
});
