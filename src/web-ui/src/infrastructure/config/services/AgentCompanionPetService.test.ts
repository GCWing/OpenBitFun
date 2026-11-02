import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import girlManifest from '../../../../public/agent-companion-pets/openbitfun-girl/pet.json';
import bitblobManifest from '../../../../public/agent-companion-pets/bitblob/pet.json';

const invoke = vi.fn();
const isTauriRuntimeMock = vi.fn(() => false);

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { invoke },
}));

vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: () => isTauriRuntimeMock(),
}));

describe('AgentCompanionPetService built-in presets', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('defaults to BitBlob v2 while retaining previous presets', async () => {
    const { DEFAULT_AGENT_COMPANION_PET, listAgentCompanionPets, resolveAgentCompanionPet } = await import('./AgentCompanionPetService');

    const pets = await listAgentCompanionPets();
    const blueGolden = pets.find(pet => pet.id === 'blue-golden');
    const openbitfun = pets.find(pet => pet.id === 'openbitfun');

    expect(DEFAULT_AGENT_COMPANION_PET).toMatchObject({
      id: 'bitblob',
      displayName: 'BitBlob',
      source: 'preset',
      packagePath: '/agent-companion-pets/bitblob',
      spritesheetPath: '/agent-companion-pets/bitblob/spritesheet.webp',
      spritesheetMimeType: 'image/webp',
      spriteVersionNumber: 2,
    });
    expect(blueGolden).toMatchObject({
      id: 'blue-golden',
      displayName: '困困',
      source: 'preset',
      packagePath: '/agent-companion-pets/blue-golden',
      spritesheetPath: '/agent-companion-pets/blue-golden/spritesheet.png',
      spritesheetMimeType: 'image/png',
    });
    expect(pets[0]).toMatchObject(DEFAULT_AGENT_COMPANION_PET);
    expect(pets[0]).toMatchObject({
      ...bitblobManifest,
      spritesheetPath: `/agent-companion-pets/${bitblobManifest.id}/${bitblobManifest.spritesheetPath}`,
    });
    expect((await resolveAgentCompanionPet(pets[0])).layout).toMatchObject({
      version: 2, columns: 8, rows: 11, supportsLook: true,
    });
    expect(openbitfun).toMatchObject({
      displayName: 'OpenBitFun',
      packagePath: '/agent-companion-pets/openbitfun',
      spritesheetPath: '/agent-companion-pets/openbitfun/spritesheet.webp',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('retains Fangling and resolves its packaged v2 layout without host access', async () => {
    const { listAgentCompanionPets, resolveAgentCompanionPet } = await import('./AgentCompanionPetService');
    const pets = await listAgentCompanionPets();
    const girl = pets[2];

    expect(pets.slice(0, 4).map(pet => pet.id)).toEqual([
      'bitblob', 'blue-golden', 'openbitfun-girl', 'deepseek-goldwhale',
    ]);
    expect(girl).toMatchObject({
      ...girlManifest,
      source: 'preset',
      spritesheetPath: `/agent-companion-pets/${girlManifest.id}/${girlManifest.spritesheetPath}`,
      spritesheetMimeType: 'image/webp',
    });
    const resolved = await resolveAgentCompanionPet(girl);
    expect(resolved.src).toBe(girl.spritesheetPath);
    expect(resolved.layout).toMatchObject({ version: 2, columns: 8, rows: 11, supportsLook: true });
    expect(invoke).not.toHaveBeenCalled();
  });
});


describe('reviewed external pet protocol', () => {
  beforeEach(() => invoke.mockReset());

  it('rejects hosts without reviewed import capability and unsafe previews', async () => {
    const { listExternalAgentCompanionPets } = await import('./AgentCompanionPetService');
    invoke.mockResolvedValueOnce({ pets: [] });
    await expect(listExternalAgentCompanionPets()).rejects.toThrow('unavailable');
    invoke.mockResolvedValueOnce({ importOperationsVersion: 1, external: {
      candidates: [{ sourceKey: 'cat', fingerprint: 'hash', pet: { packagePath: '/source/cat' }, previewDataUrl: 'file:///private/image' }], diagnostics: [],
    } });
    await expect(listExternalAgentCompanionPets()).rejects.toThrow('unavailable');
    expect(invoke).toHaveBeenCalledWith('list_agent_companion_pets', { request: { includeExternal: true, builtinImportVersion: 1 } });
  });

  it('sends the reviewed fingerprint and emits changes only after a successful copy', async () => {
    const { importReviewedAgentCompanionPet, AGENT_COMPANION_PETS_CHANGED } = await import('./AgentCompanionPetService');
    const { globalEventBus } = await import('@/infrastructure/event-bus');
    const changed = vi.fn();
    const off = globalEventBus.on(AGENT_COMPANION_PETS_CHANGED, changed);
    const candidate = {
      sourceKey: 'cat', fingerprint: 'reviewed-hash', previewDataUrl: 'data:image/png;base64,AA==',
      pet: { id: 'cat', displayName: 'Cat', source: 'codex' as const, packagePath: '/source/cat', spritesheetPath: '/source/cat/sprite.png', spritesheetMimeType: 'image/png' },
      imported: null, copyModified: false, sourceChanged: false,
    };
    try {
      invoke.mockRejectedValueOnce(new Error('Source changed'));
      await expect(importReviewedAgentCompanionPet(candidate)).rejects.toThrow('Source changed');
      expect(changed).not.toHaveBeenCalled();
      invoke.mockResolvedValueOnce({ ...candidate.pet, source: 'user', packagePath: '/native/cat' });
      await expect(importReviewedAgentCompanionPet(candidate)).resolves.toMatchObject({ packagePath: '/native/cat' });
      expect(invoke).toHaveBeenLastCalledWith('import_agent_companion_pet_package', {
        request: { path: '/source/cat', expectedFingerprint: 'reviewed-hash' },
      });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });
});


describe('bundled pet compatibility', () => {
  it('requires explicit bundled-import support while keeping custom-only older hosts usable', async () => {
    const { listExternalAgentCompanionPets } = await import('./AgentCompanionPetService');
    const candidate = { builtinId: 'codex', sourceKey: 'builtin:codex', fingerprint: 'hash', pet: { packagePath: '/app/app.asar' }, previewDataUrl: 'data:image/png;base64,AA==' };
    invoke.mockResolvedValueOnce({ importOperationsVersion: 1, external: { candidates: [candidate], diagnostics: [] } });
    await expect(listExternalAgentCompanionPets()).rejects.toThrow('unavailable');
    invoke.mockResolvedValueOnce({ importOperationsVersion: 1, external: { candidates: [], diagnostics: [] } });
    await expect(listExternalAgentCompanionPets()).resolves.toEqual({ candidates: [], diagnostics: [] });
    invoke.mockResolvedValueOnce({ importOperationsVersion: 1, builtinImportVersion: 1, external: { candidates: [candidate], diagnostics: [] } });
    await expect(listExternalAgentCompanionPets()).resolves.toMatchObject({ candidates: [{ builtinId: 'codex' }] });
  });

  it('sends the stable bundled identity with the reviewed fingerprint', async () => {
    const { importReviewedAgentCompanionPet, DEFAULT_AGENT_COMPANION_PET } = await import('./AgentCompanionPetService');
    invoke.mockResolvedValueOnce(DEFAULT_AGENT_COMPANION_PET);
    await importReviewedAgentCompanionPet({
      builtinId: 'codex', sourceKey: 'builtin:codex', fingerprint: 'reviewed',
      pet: { ...DEFAULT_AGENT_COMPANION_PET, source: 'codex', packagePath: '/installed/app.asar' },
      previewDataUrl: 'data:image/png;base64,AA==', imported: null, copyModified: false, sourceChanged: false,
    });
    expect(invoke).toHaveBeenLastCalledWith('import_agent_companion_pet_package', {
      request: { path: '/installed/app.asar', builtinId: 'codex', expectedFingerprint: 'reviewed' },
    });
  });
});

describe('user pet spritesheet reads', () => {
  const userPet = {
    id: 'pet-abc',
    displayName: 'Imported',
    source: 'user' as const,
    packagePath: '/home/user/.config/openbitfun/data/agent-companions/pet-abc',
    spritesheetPath: '/home/user/.config/openbitfun/data/agent-companions/pet-abc/spritesheet.webp',
    spritesheetMimeType: 'image/webp',
    spriteVersionNumber: 2,
  };

  beforeEach(() => {
    invoke.mockReset();
    isTauriRuntimeMock.mockReturnValue(true);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((_blob: Blob) => 'blob:pet-spritesheet'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    isTauriRuntimeMock.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  it('reads the spritesheet through the host instead of the filesystem plugin scope', async () => {
    const { resolveAgentCompanionPetSrc } = await import('./AgentCompanionPetService');
    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);

    await expect(resolveAgentCompanionPetSrc(userPet)).resolves.toBe('blob:pet-spritesheet');
    expect(invoke).toHaveBeenCalledWith('load_agent_companion_pet_spritesheet', {
      request: { spritesheetPath: userPet.spritesheetPath },
    });
  });

  it('accepts a raw byte response and reuses the cached blob URL', async () => {
    const { resolveAgentCompanionPetSrc } = await import('./AgentCompanionPetService');
    const otherPet = {
      ...userPet,
      id: 'pet-def',
      packagePath: '/home/user/.config/openbitfun/data/agent-companions/pet-def',
      spritesheetPath: '/home/user/.config/openbitfun/data/agent-companions/pet-def/spritesheet.webp',
    };
    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));

    await expect(resolveAgentCompanionPetSrc(otherPet)).resolves.toBe('blob:pet-spritesheet');
    await expect(resolveAgentCompanionPetSrc(otherPet)).resolves.toBe('blob:pet-spritesheet');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
