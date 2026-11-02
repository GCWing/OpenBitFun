import { describe, expect, it, vi } from 'vitest';
import { createSidebarRegistry, selectedSidebarEntry, type SidebarContribution, type SidebarContext } from './sidebarRegistry';
import { sidebarRegistry } from './sidebarContributions';

const context: SidebarContext = { activeSceneId: 'skills', skillsTab: 'discover', isDesktop: true, isPeer: false, surfaceId: 'local' };
const contribution: SidebarContribution = {
  id: 'example.page', labelKey: 'common:scenes.skills', icon: 'book-open',
  isActive: current => current.activeSceneId === 'skills', open: vi.fn(),
};

describe('sidebar contribution lifecycle', () => {
  it('publishes stable snapshots, rejects collisions, and supports unload/re-registration', () => {
    const registry = createSidebarRegistry();
    const changed = vi.fn();
    const stop = registry.subscribe(changed);
    const initial = registry.getSnapshot();
    expect(registry.getSnapshot()).toBe(initial);
    const dispose = registry.register(contribution);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(() => registry.register(contribution)).toThrow('duplicate');
    expect(selectedSidebarEntry(registry.getSnapshot(), ['example.page'], context)).toBe('example.page');
    dispose();
    expect(selectedSidebarEntry(registry.getSnapshot(), ['example.page'], context)).toBeUndefined();
    registry.register(contribution);
    dispose(); // An old disposer must not unregister a newer contribution.
    expect(registry.getSnapshot()).toHaveLength(1);
    stop();
  });

  it('selects the exact skills subpage and keeps unavailable remote entries inactive', () => {
    const entries = sidebarRegistry.getSnapshot();
    const pins = ['builtin.skills.installed', 'builtin.skills.discover'];
    expect(selectedSidebarEntry(entries, pins, context)).toBe('builtin.skills.discover');
    expect(selectedSidebarEntry(entries, pins, { ...context, skillsTab: 'installed' })).toBe('builtin.skills.installed');
    expect(selectedSidebarEntry(entries, pins, { ...context, isPeer: true, surfaceId: 'peer-a' })).toBeUndefined();
    expect(selectedSidebarEntry(entries, pins, { ...context, isDesktop: false })).toBeUndefined();
  });
});
