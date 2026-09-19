import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configAPI } from './ConfigAPI';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));

describe('marketplace API compatibility', () => {
  beforeEach(() => invoke.mockReset());
  it('requests source errors alongside successful search results', async () => {
    const result = { skills: [{ installId: 'skills-sh:https://corp#team/skills@review' }], sourceErrors: ['Private: offline'] };
    invoke.mockResolvedValue(result);
    expect(await configAPI.querySkillMarkets('review', 20)).toEqual(result);
    expect(invoke).toHaveBeenCalledWith('search_skill_market', {
      request: { query: 'review', limit: 20, includeDiagnostics: true },
    });
  });
  it('accepts arrays returned by older hosts', async () => {
    invoke.mockResolvedValue([{ installId: 'team/skills@review' }]);
    expect(await configAPI.querySkillMarkets(undefined, 10)).toEqual({ skills: [{ installId: 'team/skills@review' }], sourceErrors: [] });
    expect(invoke).toHaveBeenCalledWith('list_skill_market', {
      request: { query: undefined, limit: 10, includeDiagnostics: true },
    });
  });
  it('rejects malformed payloads instead of displaying an empty market', async () => {
    invoke.mockResolvedValue({ results: [] });
    await expect(configAPI.querySkillMarkets()).rejects.toThrow('Invalid marketplace response');
  });
});
