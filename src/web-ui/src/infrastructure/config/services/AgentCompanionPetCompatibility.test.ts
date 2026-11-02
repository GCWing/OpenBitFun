import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke } }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));

import { resolveAgentCompanionPet } from './AgentCompanionPetService';
import type { AgentCompanionPetSelection } from './AIExperienceConfigService';

const legacy: AgentCompanionPetSelection = {
  id: 'sample', displayName: 'Sample', source: 'user', packagePath: '/pets/sample',
  spritesheetPath: '/pets/sample/spritesheet.webp', spritesheetMimeType: 'image/webp',
};

/**
 * The host answers both the pet enumeration and the spritesheet read, so the
 * mock dispatches by command instead of returning one fixed value.
 */
function mockHost(petsResponse: unknown): void {
  invoke.mockImplementation((command: string) => {
    if (command === 'list_agent_companion_pets') return Promise.resolve(petsResponse);
    if (command === 'load_agent_companion_pet_spritesheet') {
      return Promise.resolve(new Uint8Array([0]).buffer);
    }
    return Promise.reject(new Error(`unexpected command: ${command}`));
  });
}

function invokedCommands(): string[] {
  return invoke.mock.calls.map(([command]) => command as string);
}

describe('saved pet version recovery', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:pet'), revokeObjectURL: vi.fn() });
  });

  it('recovers v2 from an already imported package without writing settings', async () => {
    mockHost({ pets: [{ ...legacy, spriteVersionNumber: 2 }] });
    const resolved = await resolveAgentCompanionPet(legacy);
    expect(resolved.layout.rows).toBe(11);
    expect(invokedCommands()).toEqual([
      'list_agent_companion_pets',
      'load_agent_companion_pet_spritesheet',
    ]);
    expect(legacy.spriteVersionNumber).toBeUndefined();
  });

  it('retains legacy manifests returned by an older host', async () => {
    mockHost({ pets: [legacy] });
    expect((await resolveAgentCompanionPet(legacy)).layout.rows).toBe(9);
  });

  it('does not require package enumeration for explicit v1 or v2 selections', async () => {
    mockHost({ pets: [legacy] });
    for (const version of [1, 2]) {
      expect((await resolveAgentCompanionPet({ ...legacy, spriteVersionNumber: version })).layout.version).toBe(version);
    }
    expect(invokedCommands()).not.toContain('list_agent_companion_pets');
  });

  it('retains an unavailable selection and reports failure instead of guessing v1', async () => {
    mockHost({ pets: [] });
    await expect(resolveAgentCompanionPet(legacy)).rejects.toThrow('unavailable');
    invoke.mockRejectedValue(new Error('Host unavailable'));
    await expect(resolveAgentCompanionPet(legacy)).rejects.toThrow('Host unavailable');
    await expect(resolveAgentCompanionPet({ ...legacy, spriteVersionNumber: 3 })).rejects.toThrow('Unsupported');
  });
});
