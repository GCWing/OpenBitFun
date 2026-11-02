import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecentModelPool, setRecentModelPool, poolForModeSwitch } from './recentModelPool';
import type { ModelPoolDefinition } from '@/infrastructure/api/service-api/ModelPoolAPI';

const pool = (id: string, members = ['m'], strategy = 'ordered'): ModelPoolDefinition => ({
  id, name: id, member_model_ids: members, strategy,
});
const models = new Set(['m']);
afterEach(() => vi.unstubAllGlobals());

describe('battery mode selection', () => {
  it('restores the remembered pool and otherwise requires a choice when multiple pools are available', () => {
    const pools = [pool('a'), pool('b')];
    expect(poolForModeSwitch(pools, models, 'b')?.id).toBe('b');
    expect(poolForModeSwitch(pools, models)).toBeUndefined();
    expect(poolForModeSwitch(pools, models, 'deleted')).toBeUndefined();
  });
  it('selects the sole usable pool without choosing missing members, empty pools or future strategies', () => {
    const pools = [pool('empty', []), pool('missing', ['gone']), pool('future', ['m'], 'future'), pool('valid')];
    expect(poolForModeSwitch(pools, models, 'missing')?.id).toBe('valid');
    expect(poolForModeSwitch(pools.slice(0, 3), models)).toBeUndefined();
    expect(poolForModeSwitch([], models)).toBeUndefined();
  });
  it('allows selection when presentation preference storage is unavailable', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('storage disabled'); } });
    expect(() => setRecentModelPool('session', 'a')).not.toThrow();
    expect(getRecentModelPool('session')).toBeUndefined();
  });
});
