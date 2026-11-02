import { resolveSettingsDestination } from '@/app/scenes/settings/settingsDestination';
import type { SettingsDestinationInput } from '@/app/scenes/settings/settingsDestination';
import migrations from '@/app/scenes/settings/settingsDestinationMigrations.json';
import type { InteractiveCapabilityDestination } from './interactiveCapabilityCatalog';

// Capability IDs are stable host contracts. Only their frontend destinations move.
const CAPABILITY_DESTINATIONS: Readonly<Record<string, {
  destination?: SettingsDestinationInput;
  items?: Readonly<Record<string, SettingsDestinationInput>>;
}>> = migrations.capabilities;

export function projectSettingsCapabilityDestination(
  capabilityId: string,
  destination: InteractiveCapabilityDestination,
  itemId?: string,
): InteractiveCapabilityDestination {
  if (destination.kind !== 'settings') return destination;
  const migration = CAPABILITY_DESTINATIONS[capabilityId];
  const override = (itemId ? migration?.items?.[itemId] : undefined) ?? migration?.destination;
  return { kind: 'settings', ...resolveSettingsDestination(override ?? destination) };
}
