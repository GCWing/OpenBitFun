import type { SceneTabId } from '@/app/components/SceneBar/types';
import type { SettingsDestination } from '@/app/scenes/settings/settingsTypes';
import type { ProductActionId } from './productActionCatalog';
import generatedCatalog from './generated/interactive-capabilities.json';
import { WORKSPACE_SEARCH_AVAILABLE } from '@/infrastructure/config/workspaceSearchAvailability';
import { projectSettingsCapabilityDestination } from './settingsCapabilityDestination';

export type InteractiveCapabilityKind = 'feature' | 'setting';
export type InteractiveCapabilityRisk = 'read' | 'write' | 'ui' | 'execute' | 'destructive';

export type InteractiveCapabilityDestination =
  | ({ kind: 'settings' } & SettingsDestination)
  | { kind: 'action'; actionId: ProductActionId }
  | { kind: 'scene'; sceneId: SceneTabId }
  | { kind: 'event'; eventName: string; detail?: Record<string, unknown> };

export interface InteractiveCapabilityValueSchema {
  type: 'boolean' | 'string' | 'integer' | 'number' | 'object' | 'array';
  nullable?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface InteractiveCapabilityOperation {
  id: string;
  titleZh: string;
  titleEn: string;
  descriptionZh: string;
  descriptionEn: string;
  risk: InteractiveCapabilityRisk;
  inputSchema: Record<string, unknown>;
  argumentScopes?: Record<string, 'productHostLocal'>;
}

export interface InteractiveCapabilityOption {
  id: string;
  titleZh: string;
  titleEn: string;
  descriptionZh: string;
  descriptionEn: string;
  valueSchema: InteractiveCapabilityValueSchema;
}

export interface InteractiveCapabilityControlDefinition {
  id: string;
  capabilityId: string;
  itemIds: string[];
  kind: 'query' | 'option' | 'operation' | 'delegate' | 'open';
  risk: InteractiveCapabilityRisk;
  executionHost: 'productHost' | 'workspaceHost' | 'presentationSurface';
  presentationTarget: InteractiveCapabilityDestination;
}

export interface InteractiveCapabilityItem {
  id: string;
  titleZh: string;
  titleEn: string;
  destination?: InteractiveCapabilityDestination;
  control:
    | {
      kind: 'direct';
      operations: string[];
      options: Array<{ id: string; value?: unknown }>;
    }
    | {
      kind: 'delegate';
      tools: string[];
      workflowZh: string[];
      workflowEn: string[];
    }
    | { kind: 'open' | 'unsupported'; reasonZh: string; reasonEn: string };
}

export interface InteractiveCapabilityAgentControl {
  tool: string;
  workflowZh: string[];
  workflowEn: string[];
}

export interface InteractiveCapability {
  id: string;
  kind: InteractiveCapabilityKind;
  titleZh: string;
  titleEn: string;
  summaryZh: string;
  summaryEn: string;
  categoryId: string;
  keywordsZh: string[];
  keywordsEn: string[];
  highlightsZh: string[];
  highlightsEn: string[];
  items: InteractiveCapabilityItem[];
  stepsZh: string[];
  stepsEn: string[];
  agentExamplesZh: string[];
  agentExamplesEn: string[];
  agentControl?: InteractiveCapabilityAgentControl;
  destination: InteractiveCapabilityDestination;
  operations: InteractiveCapabilityOperation[];
  options: InteractiveCapabilityOption[];
  searchTerms: string[];
  docsUrl: string;
}

export interface InteractiveCapabilityCatalog {
  schemaVersion: number;
  product: string;
  title: string;
  origin: string;
  source: string;
  digest: string;
  ownerDigest: string;
  searchAcceptance: Array<{
    id: string;
    query: string;
    expectedFirstCapabilityId: string;
    expectedCapabilityIds: string[];
    expectedItem?: { capabilityId: string; itemId: string };
  }>;
  counts: {
    features: number;
    settings: number;
    userFacing: number;
    documentedItems: number;
    controlCoverage: {
      direct: number;
      delegated: number;
      interactive: number;
      unsupported: number;
    };
  };
  categories: Record<string, {
    titleZh: string;
    titleEn: string;
    descriptionZh: string;
    descriptionEn: string;
  }>;
  capabilities: InteractiveCapability[];
  definitions: InteractiveCapabilityControlDefinition[];
}

// Keep the host contract intact while filtering controls unavailable for the workspace.
const hostCatalog = generatedCatalog as InteractiveCapabilityCatalog;
const catalog: InteractiveCapabilityCatalog = {
  ...hostCatalog,
  capabilities: hostCatalog.capabilities.map(capability => ({
    ...capability,
    destination: projectSettingsCapabilityDestination(capability.id, capability.destination),
    items: capability.items.map(item => ({
      ...item,
      destination: projectSettingsCapabilityDestination(capability.id, item.destination ?? capability.destination, item.id),
    })),
  })),
  definitions: hostCatalog.definitions.map(definition => ({
    ...definition,
    presentationTarget: projectSettingsCapabilityDestination(definition.capabilityId, definition.presentationTarget, definition.itemIds[0]),
  })),
};
const suspendedSearchItems = new Set(['accelerated-search', 'search-index']);
export function getInteractiveCapabilityCatalog(
  workspaceSearchAvailable = WORKSPACE_SEARCH_AVAILABLE,
): InteractiveCapabilityCatalog {
  return workspaceSearchAvailable
  ? catalog
  : {
    ...catalog,
    capabilities: catalog.capabilities.map((capability) => {
      if (capability.id !== 'setting.workspace.session') return capability;
      const items = capability.items.filter(({ id }) => !suspendedSearchItems.has(id));
      const options = capability.options.filter(({ id }) => id !== 'workspace-search');
      const titlesZh = items.map(({ titleZh }) => titleZh);
      const titlesEn = items.map(({ titleEn }) => titleEn);
      return {
        ...capability,
        items,
        options,
        summaryZh: titlesZh[0],
        summaryEn: titlesEn[0],
        keywordsZh: [capability.titleZh, ...titlesZh],
        keywordsEn: [capability.titleEn, ...titlesEn],
        highlightsZh: titlesZh,
        highlightsEn: titlesEn,
        stepsZh: capability.stepsZh.slice(0, 2),
        stepsEn: capability.stepsEn.slice(0, 2),
        agentExamplesZh: capability.agentExamplesZh.slice(0, 1),
        agentExamplesEn: capability.agentExamplesEn.slice(0, 1),
        searchTerms: [capability.titleZh, capability.titleEn, ...titlesZh, ...titlesEn],
      };
    }),
    definitions: catalog.definitions.flatMap((definition) => {
      if (definition.capabilityId !== 'setting.workspace.session') return [definition];
      const itemIds = definition.itemIds.filter((id) => !suspendedSearchItems.has(id));
      return itemIds.length ? [{ ...definition, itemIds }] : [];
    }),
  };

}

export const INTERACTIVE_CAPABILITY_CATALOG = getInteractiveCapabilityCatalog();

const capabilityById = new Map(
  INTERACTIVE_CAPABILITY_CATALOG.capabilities.map((capability) => [capability.id, capability]),
);
const definitionById = new Map(
  INTERACTIVE_CAPABILITY_CATALOG.definitions.map((definition) => [definition.id, definition]),
);

export function getInteractiveCapability(capabilityId: string): InteractiveCapability | undefined {
  return capabilityById.get(capabilityId);
}

export function getInteractiveControlDefinition(
  definitionId: string,
): InteractiveCapabilityControlDefinition | undefined {
  return definitionById.get(definitionId);
}
