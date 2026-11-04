import { afterEach, describe, expect, it } from 'vitest';
import {
  getWorkspaceDisplayOrderRevision,
  noteWorkspaceActivated,
  orderWorkspacesForDisplay,
  resetWorkspaceDisplayOrdersForTest,
  setWorkspaceDisplayOrder,
  stableWorkspaceOrder,
} from './workspaceDisplayOrder';

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

  it('keeps the shown order through several activations an older host collected while the device was rendered', () => {
    // Live list and catalog of one device, an older host that moves the
    // active workspace to the front.
    stableWorkspaceOrder('peer', list('assistant', 'herdr', 'openbitfun'));
    // Rendered: the live list activates two workspaces and keeps showing its
    // order; the catalog is not re-read meanwhile.
    noteWorkspaceActivated('peer', 'openbitfun');
    expect(ids(stableWorkspaceOrder('peer', list('assistant', 'herdr', 'openbitfun')))).toEqual(['assistant', 'herdr', 'openbitfun']);
    noteWorkspaceActivated('peer', 'herdr');
    // Left: the catalog reads the host's drifted list.
    expect(ids(stableWorkspaceOrder('peer', list('herdr', 'openbitfun', 'assistant')))).toEqual(['assistant', 'herdr', 'openbitfun']);
    // Rendered again: the live list's next read agrees, so nothing flips back.
    expect(ids(stableWorkspaceOrder('peer', list('herdr', 'openbitfun', 'assistant')))).toEqual(['assistant', 'herdr', 'openbitfun']);
  });

  it('judges a read against the host order seen last, not only the shown one', () => {
    stableWorkspaceOrder('peer', list('a', 'b', 'c'));
    // Another controller activated c, then b.
    expect(ids(stableWorkspaceOrder('peer', list('c', 'a', 'b')))).toEqual(['a', 'b', 'c']);
    expect(ids(stableWorkspaceOrder('peer', list('b', 'c', 'a')))).toEqual(['a', 'b', 'c']);
  });

  it('orders an earlier list by the shown order without changing it', () => {
    stableWorkspaceOrder('peer', list('a', 'b'));
    setWorkspaceDisplayOrder('peer', ['b', 'a']);
    const revision = getWorkspaceDisplayOrderRevision();
    expect(ids(orderWorkspacesForDisplay('peer', list('a', 'new', 'b')))).toEqual(['new', 'b', 'a']);
    expect(ids(orderWorkspacesForDisplay('other', list('a', 'b')))).toEqual(['a', 'b']);
    expect(getWorkspaceDisplayOrderRevision()).toBe(revision);
    expect(ids(stableWorkspaceOrder('peer', list('a', 'b')))).toEqual(['b', 'a']);
  });
});
