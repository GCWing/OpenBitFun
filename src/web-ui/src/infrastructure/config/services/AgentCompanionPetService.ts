import { globalEventBus } from '@/infrastructure/event-bus';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { readFile } from '@tauri-apps/plugin-fs';
import type { AgentCompanionPetSelection } from './AIExperienceConfigService';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { createLogger } from '@/shared/utils/logger';
import builtinPetMetadata from './agentCompanionBuiltinPetMetadata.json';
import { getPetSpriteLayout } from './agentCompanionPetSprite';

const log = createLogger('AgentCompanionPetService');
const BUILTIN_PET_BASE = '/agent-companion-pets';
const BUILTIN_PET_DISPLAY_NAMES = builtinPetMetadata.displayNames;

export const AGENT_COMPANION_PETS_CHANGED = 'agent-companion-pets-changed';

export const DEFAULT_AGENT_COMPANION_PET: AgentCompanionPetSelection = {
  id: 'bitblob',
  displayName: 'BitBlob',
  description: 'Rounded lavender companion with a soft antenna and curious eyes.',
  source: 'preset',
  packagePath: `${BUILTIN_PET_BASE}/bitblob`,
  spritesheetPath: `${BUILTIN_PET_BASE}/bitblob/spritesheet.webp`,
  spritesheetMimeType: 'image/webp',
  spriteVersionNumber: 2,
};

/** Cache: absolute file path → blob URL (prevents re-reading the same file). */
const blobUrlCache = new Map<string, string>();

async function readFileAsBlobUrl(absolutePath: string, mimeType: string): Promise<string> {
  const cached = blobUrlCache.get(absolutePath);
  if (cached) return cached;

  const bytes = await readFile(absolutePath);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(absolutePath, url);
  return url;
}

/**
 * Revoke cached blob URLs for files under a removed user pet package directory.
 */
export function releaseAgentCompanionPetPreviewBlobs(
  packagePath: string,
  spritesheetAbsolutePath?: string,
): void {
  const dir = packagePath.replace(/[/\\]+$/, '');
  const normPrefix = `${dir.replace(/\\/g, '/')}/`;
  const toRevoke = new Set<string>();
  for (const key of blobUrlCache.keys()) {
    const k = key.replace(/\\/g, '/');
    const d = dir.replace(/\\/g, '/');
    if (k === d || k.startsWith(normPrefix)) {
      toRevoke.add(key);
    }
  }
  if (spritesheetAbsolutePath) {
    toRevoke.add(spritesheetAbsolutePath);
  }
  for (const key of toRevoke) {
    const url = blobUrlCache.get(key);
    if (url) URL.revokeObjectURL(url);
    blobUrlCache.delete(key);
  }
}

const BUILTIN_PETS: AgentCompanionPetSelection[] = [
  {
    ...DEFAULT_AGENT_COMPANION_PET,
  },
  {
    id: 'blue-golden',
    displayName: BUILTIN_PET_DISPLAY_NAMES.blueGolden,
    description:
      'A sweet, round-faced blue-golden shaded cat with wide bright eyes and soft silver-blue fur warmed by creamy-gold highlights.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/blue-golden`,
    spritesheetPath: `${BUILTIN_PET_BASE}/blue-golden/spritesheet.png`,
    spritesheetMimeType: 'image/png',
  },
  {
    id: 'openbitfun-girl',
    displayName: BUILTIN_PET_DISPLAY_NAMES.openbitfunGirl,
    description: 'Fangling, a silver-haired short-legged companion with a softly oval face and hollow rounded-hexagon ornaments.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/openbitfun-girl`,
    spritesheetPath: `${BUILTIN_PET_BASE}/openbitfun-girl/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
    spriteVersionNumber: 2,
  },
  {
    id: 'deepseek-goldwhale',
    displayName: BUILTIN_PET_DISPLAY_NAMES.goldWhale,
    description: 'A quiet whale maid with long blue curls, a whale apron, and a gold sea-patterned skirt.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/deepseek-goldwhale`,
    spritesheetPath: `${BUILTIN_PET_BASE}/deepseek-goldwhale/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
    spriteVersionNumber: 2,
  },
  {
    id: 'openbitfun',
    displayName: 'OpenBitFun',
    description:
      "OpenBitFun's mascot — Bifang, a figure from Chinese mythology said to live on Mount Zhang'e. In the Classic of Mountains and Seas (Shan Hai Jing · Western Mountains), Bifang is described as crane-like with one foot, blue feathers marked with red, and a white beak.",
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/openbitfun`,
    spritesheetPath: `${BUILTIN_PET_BASE}/openbitfun/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'boxcat',
    displayName: 'Boxcat',
    description: 'A tiny cat tucked inside a cardboard box for cozy coding sessions.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/boxcat`,
    spritesheetPath: `${BUILTIN_PET_BASE}/boxcat/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'capy',
    displayName: 'Capy',
    description: 'An original emotionally stable capybara with a tiny orange on its head.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/capy`,
    spritesheetPath: `${BUILTIN_PET_BASE}/capy/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },

  {
    id: 'elaina',
    displayName: 'Elaina',
    description: 'A cute pixel-art Codex pet inspired by Elaina, the tiny traveling witch with a bright hat and gentle broom-side charm.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/elaina-2`,
    spritesheetPath: `${BUILTIN_PET_BASE}/elaina-2/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'gugugaga',
    displayName: BUILTIN_PET_DISPLAY_NAMES.gugugaga,
    description: 'A cheerful chibi girl in a black penguin suit with a simple silver collar pendant.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/gugugaga`,
    spritesheetPath: `${BUILTIN_PET_BASE}/gugugaga/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'hachiware',
    displayName: 'Hachiware',
    description:
      'A tiny Hachiware-inspired desktop pet with white and blue cat markings, bright eyes, and cheerful expressions.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/hachiware`,
    spritesheetPath: `${BUILTIN_PET_BASE}/hachiware/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'ikun',
    displayName: 'IKUN',
    description: 'A hoodie chick with hot path stage energy.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/ikun`,
    spritesheetPath: `${BUILTIN_PET_BASE}/ikun/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'jiyi',
    displayName: BUILTIN_PET_DISPLAY_NAMES.jiyi,
    description:
      'A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/jiyi`,
    spritesheetPath: `${BUILTIN_PET_BASE}/jiyi/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
  {
    id: 'panda-pix',
    displayName: 'Panda',
    description: 'Codux bundled pet atlas.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/panda-pix`,
    spritesheetPath: `${BUILTIN_PET_BASE}/panda-pix/spritesheet.png`,
    spritesheetMimeType: 'image/png',
  },
  {
    id: 'usagi',
    displayName: 'Usagi',
    description: 'A tiny cream rabbit companion based on the provided Usagi reference.',
    source: 'preset',
    packagePath: `${BUILTIN_PET_BASE}/usagi`,
    spritesheetPath: `${BUILTIN_PET_BASE}/usagi/spritesheet.webp`,
    spritesheetMimeType: 'image/webp',
  },
];

export interface AgentCompanionPetPackage extends AgentCompanionPetSelection {
  previewSrc: string;
}

interface ListAgentCompanionPetsResponse {
  pets: AgentCompanionPetSelection[];
}

async function withPreviewSrc(pet: AgentCompanionPetSelection): Promise<AgentCompanionPetPackage> {
  const previewSrc = pet.source === 'preset'
    ? pet.spritesheetPath
    : isTauriRuntime()
      ? await readFileAsBlobUrl(pet.spritesheetPath, pet.spritesheetMimeType)
      : '';
  return { ...pet, previewSrc };
}

export async function listAgentCompanionPets(): Promise<AgentCompanionPetPackage[]> {
  const builtinPets = await Promise.all(BUILTIN_PETS.map(withPreviewSrc));
  if (!isTauriRuntime()) return builtinPets;
  try {
    const response = await api.invoke<ListAgentCompanionPetsResponse>('list_agent_companion_pets');
    const userPets = await Promise.all(response.pets.map(withPreviewSrc));
    return [...builtinPets, ...userPets];
  } catch (error) {
    log.error('Failed to list Agent companion pets', error);
    return builtinPets;
  }
}

export async function selectAgentCompanionPetPackage(title: string): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error('Pet package selection requires the desktop surface');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    directory: false,
    multiple: false,
    title,
    filters: [{ name: 'Petdex', extensions: ['zip'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function importAgentCompanionPetPackage(path: string): Promise<AgentCompanionPetPackage> {
  const pet = await api.invoke<AgentCompanionPetSelection>('import_agent_companion_pet_package', {
    request: { path },
  });
  globalEventBus.emit(AGENT_COMPANION_PETS_CHANGED, {});
  return withPreviewSrc(pet);
}

export async function deleteAgentCompanionPetPackage(packagePath: string): Promise<void> {
  await api.invoke('delete_agent_companion_pet_package', {
    request: { packagePath },
  });
  globalEventBus.emit(AGENT_COMPANION_PETS_CHANGED, {});
}

/**
 * Resolve the image source for a pet's spritesheet.
 * For preset pets, returns the web-public relative path directly.
 * For user-imported pets, reads the file from disk and returns a blob URL (cached).
 */
export async function resolveAgentCompanionPetSrc(
  pet: AgentCompanionPetSelection | null | undefined,
): Promise<string> {
  if (!pet) return '';
  if (pet.source === 'preset') return pet.spritesheetPath;
  if (!isTauriRuntime()) return '';
  return readFileAsBlobUrl(pet.spritesheetPath, pet.spritesheetMimeType);
}

/** Recover the version omitted by older builds without rewriting or discarding user settings. */
export async function resolveAgentCompanionPet(pet: AgentCompanionPetSelection) {
  let resolved = pet;
  if (pet.source === 'user' && pet.spriteVersionNumber == null && isTauriRuntime()) {
    const { pets } = await api.invoke<ListAgentCompanionPetsResponse>('list_agent_companion_pets');
    const installed = pets.find(item => item.packagePath === pet.packagePath);
    if (!installed) throw new Error('Selected pet package is unavailable or unsupported');
    resolved = installed;
  }
  const layout = getPetSpriteLayout(resolved.spriteVersionNumber);
  const src = await resolveAgentCompanionPetSrc(resolved);
  return { src, layout };
}


export interface ExternalPetCandidate {
  sourceKey: string;
  fingerprint: string;
  pet: Omit<AgentCompanionPetSelection, 'source'> & { source: 'codex' };
  previewDataUrl: string;
  imported: AgentCompanionPetSelection | null;
  copyModified: boolean;
  sourceChanged: boolean;
  builtinId?: string;
}

export interface ExternalPetCatalog {
  candidates: ExternalPetCandidate[];
  diagnostics: string[];
}

/** An explicit version proves the host checks the reviewed package before copying. */
export async function listExternalAgentCompanionPets(): Promise<ExternalPetCatalog> {
  const response = await api.invoke<{
    importOperationsVersion?: number;
    builtinImportVersion?: number;
    external?: ExternalPetCatalog;
  }>('list_agent_companion_pets', { request: { includeExternal: true, builtinImportVersion: 1 } });
  if (response.importOperationsVersion !== 1 || !response.external
    || !Array.isArray(response.external.candidates) || !Array.isArray(response.external.diagnostics)
    || response.external.candidates.some((entry) => (entry.builtinId != null
      && (typeof entry.builtinId !== 'string' || !entry.builtinId || response.builtinImportVersion !== 1))
      || typeof entry.sourceKey !== 'string'
      || typeof entry.fingerprint !== 'string' || typeof entry.pet?.packagePath !== 'string'
      || typeof entry.previewDataUrl !== 'string' || !entry.previewDataUrl.startsWith('data:image/png;base64,'))) {
    throw new Error('Pet discovery or reviewed import is unavailable on this host');
  }
  return response.external;
}

export async function importReviewedAgentCompanionPet(candidate: ExternalPetCandidate): Promise<AgentCompanionPetSelection> {
  const pet = await api.invoke<AgentCompanionPetSelection>('import_agent_companion_pet_package', {
    request: { path: candidate.pet.packagePath, expectedFingerprint: candidate.fingerprint,
      ...(candidate.builtinId ? { builtinId: candidate.builtinId } : {}),
    },
  });
  globalEventBus.emit(AGENT_COMPANION_PETS_CHANGED, {});
  return pet;
}
