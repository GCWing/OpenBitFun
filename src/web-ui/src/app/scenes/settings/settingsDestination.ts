import migrations from './settingsDestinationMigrations.json';
import { DEFAULT_SETTINGS_PAGE_ID, getSettingsPageManifest, isSettingsPageId } from './settingsRegistry';
import type { SettingsDestination } from './settingsTypes';

const LEGACY_ECOSYSTEM_COMPATIBILITY_IDS = new Set([
  'external-sources',
  'tools.integrations',
]);

/** Old Settings links now redirect to the owning product surface. */
export function isLegacyEcosystemCompatibilityDestination(value: unknown): boolean {
  if (typeof value === 'string') {
    return LEGACY_ECOSYSTEM_COMPATIBILITY_IDS.has(value);
  }
  if (!value || typeof value !== 'object' || !('pageId' in value)) return false;
  return typeof value.pageId === 'string'
    && LEGACY_ECOSYSTEM_COMPATIBILITY_IDS.has(value.pageId);
}

/**
 * Upgrade boundary for links emitted by older installs, extensions, and peers.
 * Product code must use canonical SettingsDestination values directly; legacy
 * identifiers are contained in settingsDestinationMigrations.json so the catalog
 * validator and the frontend share the same compatibility boundary.
 */
const LEGACY_DESTINATION_MIGRATIONS: Readonly<Record<string, SettingsDestinationInput>> = migrations.pages;
const LEGACY_VIEW_MIGRATIONS: Readonly<Record<string, Readonly<Record<string, SettingsDestinationInput>>>> = migrations.views;

export interface SettingsDestinationInput {
  pageId: string;
  viewId?: string;
  sectionId?: string;
}

/** Normalize both old page IDs and old tab links before entering the settings store. */
export function resolveSettingsDestination(value: string | SettingsDestinationInput): SettingsDestination {
  const input = typeof value === 'string' ? { pageId: value } : value;
  const migrated = (input.viewId ? LEGACY_VIEW_MIGRATIONS[input.pageId]?.[input.viewId] : undefined)
    ?? LEGACY_DESTINATION_MIGRATIONS[input.pageId];
  const pageId = migrated?.pageId ?? input.pageId;
  const destination: SettingsDestination = {
    pageId: isSettingsPageId(pageId) ? pageId : DEFAULT_SETTINGS_PAGE_ID,
  };
  const manifest = getSettingsPageManifest(destination.pageId);
  const sectionId = input.sectionId
    ?? migrated?.sectionId;
  const section = manifest.sections?.find(section => section.id === sectionId);
  const view = manifest.views?.find(view => view.id === input.viewId);
  return {
    pageId: destination.pageId,
    ...(section ? { sectionId: section.id } : {}),
    ...(view ? { viewId: view.id } : {}),
  };
}
