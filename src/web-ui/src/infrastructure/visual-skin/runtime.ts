import { createLogger } from '@/shared/utils/logger';
import { isVisualSkinSlotId, isVisualSkinSlotPropertyName, isVisualSkinSurfaceId, stateSelector, tokenVariable, VISUAL_SKIN_SURFACE_BASE_TOKENS } from './contract';
import { resolveSkinMode as resolveMode, resolveSkinSurfaces } from './resolve';
import { ownedParts, partStateAnchors, skinNodeSelector, SKIN_NODE_ATTRIBUTE } from './targets';
import { compilePartPaint, partAssetDeclarations } from './part-paint';
import { VisualSkinImageResources } from './asset-resources';
import { VisualSkinPackageParser } from './parser';
import { createVisualSkinStorage, toVisualSkinCatalogEntry, type VisualSkinStorage } from './storage';
import type {
  StoredVisualSkin,
  VisualSkinCatalogEntry,
  VisualSkinMode,
  VisualSkinSnapshot,
  VisualSkinProjectionEntry,
  VisualSkinProjectionReport,
  VisualSkinStateRecipe,
  VisualSkinPartRecipe,
} from './types';

const log = createLogger('VisualSkinRuntime');
const STYLE_ATTRIBUTE = 'data-openbitfun-skin-runtime';
const ACTIVE_ID_ATTRIBUTE = 'data-openbitfun-skin-id';
const SURFACE_ATTRIBUTE = 'data-openbitfun-skin-surface';
const ARTWORK_ATTRIBUTE = 'data-openbitfun-skin-artwork';
const BACKGROUND_SOURCE_ATTRIBUTE = 'data-openbitfun-skin-background-source';
const SAFE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_STATE = /^[a-z][a-z0-9_-]{0,48}$/;
const SAFE_BACKGROUND_POSITION = /^(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%)(?:\s+(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%))?$/;
const DEFAULT_SCRIM_OPACITY = 0;
const PAINT_ATTRIBUTES = ['data-openbitfun-paint-layer', 'data-openbitfun-edge-layer', 'data-openbitfun-component', 'data-openbitfun-product-component', 'data-openbitfun-scene', 'data-openbitfun-surface', 'data-openbitfun-skin-slot', 'data-openbitfun-part', 'data-openbitfun-product-part'];
const PAINT_TARGET_SELECTOR = PAINT_ATTRIBUTES.map(name => `[${name}]`).join(',');


function cssEscape(value: string): string {
  return value.replace(/[^a-z0-9_.-]/gi, '');
}

function currentMode(): VisualSkinMode {
  const scheme = document.documentElement.getAttribute('data-color-scheme') === 'dark' ? 'dark' : 'light';
  const contrast = document.documentElement.getAttribute('data-contrast') === 'high' ? 'high' : 'standard';
  if (contrast === 'high') return scheme === 'dark' ? 'highContrastDark' : 'highContrastLight';
  return scheme;
}

function hasShellArtwork(skin: StoredVisualSkin, mode: VisualSkinMode): boolean {
  const shell = resolveSkinSurfaces(skin, mode).selected.find(entry => entry.surface.surface === 'shell')?.surface;
  return Boolean(shell?.backgroundAssetId && skin.assets[shell.backgroundAssetId]?.dataUrl && (shell.backgroundOpacity ?? 1) > 0);
}



function safeFit(value: unknown): value is 'cover' | 'contain' | 'fill' {
  return value === 'cover' || value === 'contain' || value === 'fill';
}

function safeOpacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function declaration(name: string, value: string | number): string {
  return `${name}:${String(value)} !important;`;
}

function surfaceDeclaration(name: string, value: string | number): string {
  const variable = `--openbitfun-skin-surface-${name}`;
  if (typeof document !== 'undefined') {
    const style = document.createElement('div').style;
    style.setProperty(`--openbitfun-skin-surface-${name}`, String(value), 'important');
    return style.cssText.replace(/:\s+/g, ':');
  }
  return declaration(variable, value);
}

function slotDeclarations(slot: string, values: Partial<Record<string, string | number>>): string {
  const style = typeof document !== 'undefined' ? document.createElement('div').style : null;
  const fallback: string[] = [];
  Object.entries(values).forEach(([name, value]) => {
    if (!SAFE_IDENTIFIER.test(name) || !isVisualSkinSlotPropertyName(name) || value === undefined) return;
    const cssName = `--openbitfun-skin-slot-${slot.replace(/[._]/g, '-')}-${name.replace(/[._]/g, '-')}`;
    fallback.push(`${cssName}:${String(value)} !important;`);
    if (style) {
      style.setProperty(`--openbitfun-skin-slot-${slot.replace(/[._]/g, '-')}-${name.replace(/[._]/g, '-')}`, String(value), 'important');
    }
  });
  return style?.cssText || fallback.join('');
}

function compileStateRule(
  selector: string,
  state: string,
  recipe: VisualSkinStateRecipe,
  skin: StoredVisualSkin,
  baseSlots?: VisualSkinStateRecipe['slots'],
): string {
  const stateSuffix = stateSelector(state as Parameters<typeof stateSelector>[0]);
  const tokens = Object.entries(recipe.tokens ?? {}).flatMap(([name, value]) => {
    const variable = tokenVariable(name);
    return variable ? [declaration(variable, value)] : [];
  }).join('');
  const mergedSlots = Object.fromEntries(Object.entries(recipe.slots ?? {}).map(([part, paint]) => [part, { ...baseSlots?.[part], ...paint }]));
  const slotRules = compilePartRules(selector, mergedSlots, skin, stateSuffix);
  const stateRule = tokens ? `${selector}${stateSuffix}{${tokens}}` : '';
  return [stateRule, slotRules].filter(Boolean).join('\n');
}

function compilePartRules(selector: string, slots: VisualSkinStateRecipe['slots'], skin: StoredVisualSkin, state = ''): string {
  const rules: string[] = [];
  for (const owner of document.querySelectorAll(selector)) {
    for (const [part, recipe] of Object.entries(slots ?? {})) {
      const paint = compilePartPaint(recipe, skin);
      for (const node of ownedParts(owner, part)) {
        const nodeSelector = skinNodeSelector(node);
        const anchors = state ? partStateAnchors(owner, node) : [node];
        for (const anchor of anchors) {
          const target = anchor === node ? nodeSelector + state : `${skinNodeSelector(anchor)}${state} ${nodeSelector}`;
          const paintTarget = node.getAttribute('data-openbitfun-paint-layer') === 'before' ? `${target}::before` : target;
          const edgeTarget = node.getAttribute('data-openbitfun-edge-layer') === 'before' ? `${target}::before` : target;
          if (paint.background) rules.push(`:root[${ACTIVE_ID_ATTRIBUTE}] ${paintTarget}{${paint.background}}`);
          if (paint.edge) rules.push(`:root[${ACTIVE_ID_ATTRIBUTE}] ${edgeTarget}{${paint.edge}}`);
          if (paint.content) rules.push(`:root[${ACTIVE_ID_ATTRIBUTE}] ${target}{${paint.content}}`);
        }
      }
    }
  }
  return rules.join('\n');
}

function createProjectionReport(skin: StoredVisualSkin): VisualSkinProjectionReport {
  const entries: VisualSkinProjectionEntry[] = [];
  // Reuse the same owner/part lookup across base and state entries in one report.
  // Nothing is cached across reports, so mounted/unmounted targets stay current.
  const targets = new Map<string, Element[]>();
  const parts = new Map<Element, Map<string, Element[]>>();
  const mountedElements = (selector: string): Element[] => {
    let nodes = targets.get(selector);
    if (!nodes) { nodes = typeof document === 'undefined' ? [] : [...document.querySelectorAll(selector)]; targets.set(selector, nodes); }
    return nodes;
  };
  const mountedCount = (selector: string): number => mountedElements(selector).length;
  const mountedParts = (owner: Element, part: string): Element[] => {
    let ownerParts = parts.get(owner);
    if (!ownerParts) { ownerParts = new Map(); parts.set(owner, ownerParts); }
    let nodes = ownerParts.get(part);
    if (!nodes) { nodes = ownedParts(owner, part); ownerParts.set(part, nodes); }
    return nodes;
  };
  const add = (path: string, status: VisualSkinProjectionEntry['status'], message: string) => entries.push({ path, status, message });
  const targetStatus = (supported: boolean, matches: number): VisualSkinProjectionEntry['status'] => !supported ? 'unsupported' : matches > 0 ? 'projected' : 'unresolved';
  const addTokens = (path: string, tokens: Record<string, string | number> | Partial<Record<string, string | number>> | undefined, supportedStatus: VisualSkinProjectionEntry['status']) => {
    Object.keys(tokens ?? {}).forEach(name => {
      const supported = Boolean(tokenVariable(name));
      add(`${path}.${name}`, !supported ? 'unsupported' : supportedStatus, !supported ? 'Token is outside the active design-token contract.' : supportedStatus === 'projected' ? 'Projects to a public design token.' : 'Token is valid but its target is not mounted in the current view.');
    });
  };
  const addSlotValues = (path: string, values: Record<string, string | number> | Partial<Record<string, string | number>> | undefined, status: VisualSkinProjectionEntry['status']) => {
    Object.keys(values ?? {}).forEach(name => add(`${path}.${name}`, isSafeSkinDeclarationName(name) && isVisualSkinSlotPropertyName(name) ? status : 'unsupported', isSafeSkinDeclarationName(name) && isVisualSkinSlotPropertyName(name) ? 'Projects through the named slot contract.' : 'Slot declaration name is outside the product slot contract.'));
  };
  const addSlotRecipe = (path: string, slotRecipe: VisualSkinPartRecipe, matches: number, skinAssets: StoredVisualSkin['assets'], basePart?: VisualSkinPartRecipe) => {
    const slotStatus = matches > 0 ? 'projected' : 'unresolved';
    const effective = { ...basePart, ...slotRecipe };
    const hasAsset = Boolean(effective.assetId && skinAssets[effective.assetId]?.dataUrl);
    const missingAsset = Boolean(effective.assetId && !hasAsset);
    add(path, missingAsset ? 'unsupported' : slotStatus, missingAsset ? 'Slot references an unavailable asset.' : matches > 0 ? `Projected to ${matches} mounted part(s).` : 'No independent paint target: the part is absent or delegates its surface to its container.');
    if (slotRecipe.assetId) add(`${path}.assetId`, missingAsset ? 'unsupported' : slotStatus, missingAsset ? 'Asset is not installed in the skin package.' : 'Projects the declared decorative asset.');
    if (slotRecipe.fit) add(`${path}.fit`, hasAsset ? slotStatus : 'unsupported', hasAsset ? 'Projects the bounded asset fit mode.' : 'Asset fit requires a materialized decorative asset.');
    for (const field of ['backgroundSize','backgroundPosition','backgroundRepeat','backgroundOpacity','backgroundToken','textShadowToken','foregroundToken','borderToken','shadowToken'] as const) {
      if (slotRecipe[field] !== undefined) add(`${path}.${field}`, slotStatus, 'Projects bounded part paint; visual appearance is not verified.');
    }
  };
  const addStateRecipe = (path: string, selector: string, recipe: VisualSkinStateRecipe | undefined, skinAssets: StoredVisualSkin['assets'], supported: boolean, partOwnerSelector = selector, partState = '', baseSlots?: VisualSkinStateRecipe['slots']) => {
    if (!recipe) return;
    const owners = supported ? mountedElements(partOwnerSelector) : [];
    const partMatches = (part: string) => owners.reduce((count, owner) => count + mountedParts(owner, part).filter(node => !partState || partStateAnchors(owner, node).some(anchor => anchor.matches(partState))).length, 0);
    const ownerMatches = partState ? owners.filter(owner => owner.matches(partState)).length : owners.length;
    const stateMatches = ownerMatches + Object.keys(recipe.slots ?? {}).reduce((count, part) => count + partMatches(part), 0);
    const stateStatus = targetStatus(supported, stateMatches);
    add(path, stateStatus, !supported ? 'Target is outside the product contract.' : stateMatches > 0 ? `Projected to ${stateMatches} mounted state(s).` : 'State is valid but is not active in the current view.');
    addTokens(`${path}.tokens`, recipe.tokens, targetStatus(supported, ownerMatches));
    Object.entries(recipe.slots ?? {}).forEach(([slot, slotRecipe]) => {
      if (!slotRecipe) return;
      const matches = partMatches(slot);
      addSlotRecipe(`${path}.slots.${slot}`, slotRecipe, matches, skinAssets, baseSlots?.[slot]);
    });
  };

  const mode = currentMode();
  const resolved = resolveMode(skin, mode);
  Object.entries(skin.modes).forEach(([sourceMode, patch]) => {
    for (const name of Object.keys(patch.tokens ?? {})) {
      const path = `modes.${sourceMode}.tokens.${name}`;
      const selected = resolved.sources.get(`tokens.${name}`) === sourceMode;
      add(path, selected ? 'projected' : 'inactive', selected
        ? `Declaration projected to the root in ${mode} (base: ${resolved.baseMode}); this is not visual verification.`
        : `Not selected in ${mode}, or replaced by its mode override.`);
    }
    Object.entries(patch.slots ?? {}).forEach(([slot, values]) => {
      const supported = isVisualSkinSlotId(slot);
      const selected = resolved.sources.get(`slots.${slot}`) === sourceMode;
      const matches = supported ? mountedCount(`[data-openbitfun-skin-slot="${cssEscape(slot)}"]`) : 0;
      const status = !selected ? 'inactive' : targetStatus(supported, matches);
      add(`modes.${sourceMode}.slots.${slot}`, status, !selected ? `Not selected in ${mode}, or replaced by its mode override.` : !supported ? 'Slot is outside the product contract.' : matches ? 'Declaration projected to a mounted slot; visual appearance is not verified.' : 'Slot is not mounted.');
      addSlotValues(`modes.${sourceMode}.slots.${slot}`, values, status);
    });
  });

  (skin.components ?? []).forEach((component, index) => {
    const selector = `[data-openbitfun-component="${cssEscape(component.component)}"],[data-openbitfun-product-component="${cssEscape(component.component)}"],[data-openbitfun-scene="${cssEscape(component.component)}"]`;
    const groupedSelector = `:is(${selector})`;
    const matches = mountedCount(selector);
    const componentStatus = targetStatus(true, matches);
    add(`components[${index}]`, componentStatus, matches > 0 ? `Projected to ${matches} mounted component(s).` : 'Component contract is valid but no matching component is mounted in the current view.');
    addTokens(`components[${index}].tokens`, component.tokens, componentStatus);
    Object.entries(component.slots ?? {}).forEach(([slot, slotRecipe]) => {
      if (!slotRecipe) return;
      const slotMatches = mountedElements(selector).reduce((count, owner) => count + mountedParts(owner, slot).length, 0);
      addSlotRecipe(`components[${index}].slots.${slot}`, slotRecipe, slotMatches, skin.assets);
    });
    Object.entries(component.states ?? {}).forEach(([state, recipe]) => {
      if (!SAFE_STATE.test(state)) {
        add(`components[${index}].states.${state}`, 'unsupported', 'State id is outside the safe interaction-state contract.');
        return;
      }
      addStateRecipe(`components[${index}].states.${state}`, `${groupedSelector}${stateSelector(state)}`, recipe, skin.assets, true, groupedSelector, stateSelector(state), component.slots);
    });
  });

  const surfaces = resolveSkinSurfaces(skin, mode);
  surfaces.inactive.forEach(({ path }) => add(path, 'inactive', `Surface profile is not selected in ${mode}, or replaced by its mode override.`));
  surfaces.selected.forEach(({ surface, path }) => {
    const supported = isVisualSkinSurfaceId(surface.surface);
    const selector = `[data-openbitfun-surface="${cssEscape(surface.surface)}"]`;
    const matches = supported ? mountedCount(selector) : 0;
    const surfaceStatus = targetStatus(supported, matches);
    add(`${path}`, surfaceStatus, !supported ? 'Surface is outside the product surface contract.' : matches > 0 ? `Projected to ${matches} mounted surface(s).` : 'Surface contract is valid but no matching surface is mounted in the current view.');
    addTokens(`${path}.tokens`, surface.tokens, surfaceStatus);
    if (surface.baseToken) add(`${path}.baseToken`, tokenVariable(surface.baseToken) ? surfaceStatus : 'unsupported', tokenVariable(surface.baseToken) ? 'Provides the opaque surface fallback.' : 'Base token is outside the surface contract.');
    const sharedBackdrop = surface.backgroundSource === 'shell';
    const shellAvailable = hasShellArtwork(skin, mode);
    if (sharedBackdrop) add(`${path}.backgroundSource`, shellAvailable ? surfaceStatus : 'unsupported', shellAvailable ? 'Reveals the single shell backdrop in its original coordinates; opaque descendants may still cover it.' : 'No visible shell backdrop in the selected mode; the opaque reading base remains.');
    if (surface.baseOpacity !== undefined) add(`${path}.baseOpacity`, sharedBackdrop && !shellAvailable ? 'unsupported' : surfaceStatus, 'Controls only the base material; content opacity and geometry are unchanged.');
    const backdrop = surface.backgroundAssetId ? skin.assets[surface.backgroundAssetId] : undefined;
    const hasBackdrop = Boolean(backdrop?.dataUrl);
    if (surface.backgroundAssetId) add(`${path}.backgroundAssetId`, !backdrop?.dataUrl ? 'unsupported' : surfaceStatus, !backdrop ? 'Backdrop asset is missing.' : !backdrop.dataUrl ? 'Backdrop asset has no materialized data.' : surfaceStatus === 'projected' ? 'Provides the surface backdrop asset.' : 'Backdrop asset is valid but the surface is not mounted in the current view.');
    if (surface.fit) add(`${path}.fit`, hasBackdrop ? surfaceStatus : 'unsupported', hasBackdrop ? 'Projects the bounded backdrop fit mode.' : 'Backdrop fit requires a materialized backdrop asset.');
    if (surface.backgroundPosition) add(`${path}.backgroundPosition`, hasBackdrop ? surfaceStatus : 'unsupported', hasBackdrop ? 'Projects the bounded backdrop focal position.' : 'Backdrop position requires a materialized backdrop asset.');
    if (surface.backgroundOpacity !== undefined) add(`${path}.backgroundOpacity`, hasBackdrop ? surfaceStatus : 'unsupported', hasBackdrop ? 'Projects the backdrop opacity without dimming content.' : 'Backdrop opacity requires a materialized backdrop asset.');
    if (surface.scrimToken) add(`${path}.scrimToken`, tokenVariable(surface.scrimToken) ? surfaceStatus : 'unsupported', tokenVariable(surface.scrimToken) ? 'Provides the contrast scrim token.' : 'Scrim token is outside the surface contract.');
    if (surface.scrimOpacity !== undefined) add(`${path}.scrimOpacity`, surface.scrimToken ? surfaceStatus : 'unsupported', surface.scrimToken ? 'Projects the contrast scrim opacity.' : 'Scrim opacity requires a scrim token.');
    Object.entries(surface.states ?? {}).forEach(([state, recipe]) => {
      if (!SAFE_STATE.test(state)) {
        add(`${path}.states.${state}`, 'unsupported', 'State id is outside the safe interaction-state contract.');
        return;
      }
      addStateRecipe(`${path}.states.${state}`, `${selector}${stateSelector(state)}`, recipe, skin.assets, supported, selector, stateSelector(state));
    });
  });

  return {
    mode, baseMode: resolved.baseMode,
    inactive: entries.filter(entry => entry.status === 'inactive').length,
    projected: entries.filter(entry => entry.status === 'projected').length,
    unresolved: entries.filter(entry => entry.status === 'unresolved').length,
    unsupported: entries.filter(entry => entry.status === 'unsupported').length,
    entries,
  };
}

function isSafeSkinDeclarationName(value: string): boolean {
  return SAFE_IDENTIFIER.test(value);
}

function compileSkinCss(skin: StoredVisualSkin, partUrls: ReadonlyMap<string, string>): string {
  const mode = resolveMode(skin, currentMode()).patch;
  const id = cssEscape(skin.manifest.id);
  const rootSelector = `:root[${ACTIVE_ID_ATTRIBUTE}="${id}"]`;
  const rootDeclarations = Object.entries(mode.tokens ?? {}).flatMap(([name, value]) => {
    const variable = tokenVariable(name);
    return variable ? [declaration(variable, value)] : [];
  }).join('');
  const rules: string[] = [];
  const assetDeclarations = partAssetDeclarations(skin, partUrls);
  if (rootDeclarations || assetDeclarations) rules.push(`${rootSelector}{${rootDeclarations}${assetDeclarations}}`);

  Object.entries(mode.slots ?? {}).forEach(([slot, values]) => {
    if (!SAFE_IDENTIFIER.test(slot) || !isVisualSkinSlotId(slot)) return;
    const declarations = slotDeclarations(slot, values ?? {});
    if (declarations) rules.push(`${rootSelector} [data-openbitfun-skin-slot="${cssEscape(slot)}"]{${declarations}}`);
  });

  (skin.components ?? []).forEach(recipe => {
    if (!SAFE_IDENTIFIER.test(recipe.component)) return;
    const componentSelector = `${rootSelector} :is([data-openbitfun-component="${cssEscape(recipe.component)}"],[data-openbitfun-product-component="${cssEscape(recipe.component)}"],[data-openbitfun-scene="${cssEscape(recipe.component)}"])`;
    const tokenDeclarations = Object.entries(recipe.tokens ?? {}).flatMap(([name, value]) => {
      const variable = tokenVariable(name);
      return variable ? [declaration(variable, value)] : [];
    }).join('');
    if (tokenDeclarations) rules.push(`${componentSelector}{${tokenDeclarations}}`);
    rules.push(compilePartRules(componentSelector, recipe.slots, skin));
    Object.entries(recipe.states ?? {}).forEach(([state, stateRecipe]) => {
      if (stateRecipe && SAFE_STATE.test(state)) rules.push(compileStateRule(componentSelector, state, stateRecipe, skin, recipe.slots));
    });
  });

  resolveSkinSurfaces(skin, currentMode()).selected.forEach(({ surface }) => {
    if (!SAFE_IDENTIFIER.test(surface.surface) || !isVisualSkinSurfaceId(surface.surface)) return;
    const asset = surface.backgroundAssetId ? skin.assets[surface.backgroundAssetId] : undefined;
    const backgroundUrl = surface.backgroundAssetId ? partUrls.get(surface.backgroundAssetId) : undefined;
    if (asset?.dataUrl && !backgroundUrl) throw new Error(`Visual skin image URL is missing: ${surface.backgroundAssetId}`);
    const backgroundOpacity = surface.backgroundOpacity ?? (asset?.dataUrl ? 1 : undefined);
    const baseToken = tokenVariable(surface.baseToken ?? VISUAL_SKIN_SURFACE_BASE_TOKENS[surface.surface]);
    const sharedBackdrop = surface.backgroundSource === 'shell' && hasShellArtwork(skin, currentMode());
    const baseOpacity = surface.backgroundSource === 'shell' && !sharedBackdrop ? 1 : surface.baseOpacity ?? 1;
    const baseFill = baseToken && safeOpacity(baseOpacity) ? `color-mix(in srgb, var(${baseToken}) ${baseOpacity * 100}%, transparent)` : '';
    const scrimToken = surface.scrimToken;
    const scrimOpacity = surface.scrimOpacity ?? (scrimToken ? DEFAULT_SCRIM_OPACITY : undefined);
    const declarations = [
      // Keep the opaque base fill on the surface itself. The image and scrim
      // pseudo-layers can then have independent opacity without exposing the
      // product canvas underneath the surface.
      baseToken ? declaration('background-color', baseOpacity === 1 ? `var(${baseToken})` : baseFill) : '',
      backgroundUrl ? surfaceDeclaration('background-image', `url("${backgroundUrl}")`) : '',
      asset?.dataUrl ? surfaceDeclaration('background-size', surface.fit === 'fill' ? '100% 100%' : safeFit(surface.fit) ? surface.fit : 'cover') : '',
      asset?.dataUrl && surface.backgroundPosition && SAFE_BACKGROUND_POSITION.test(surface.backgroundPosition) ? surfaceDeclaration('background-position', surface.backgroundPosition) : '',
      asset?.dataUrl && safeOpacity(backgroundOpacity) ? surfaceDeclaration('background-opacity', backgroundOpacity) : '',
      scrimToken && tokenVariable(scrimToken)
        ? surfaceDeclaration('scrim-color', `var(${tokenVariable(scrimToken)})`)
        : '',
      scrimToken && tokenVariable(scrimToken) && safeOpacity(scrimOpacity) ? surfaceDeclaration('scrim-opacity', scrimOpacity) : '',
    ].join('');
    const surfaceSelector = `${rootSelector} [data-openbitfun-surface="${cssEscape(surface.surface)}"][${SURFACE_ATTRIBUTE}="${cssEscape(surface.surface)}"]`;
    if (declarations) rules.push(`${surfaceSelector}{${declarations}}`);
    const surfaceTokens = Object.entries(surface.tokens ?? {}).flatMap(([name, value]) => {
      const variable = tokenVariable(name);
      return variable ? [declaration(variable, value)] : [];
    }).join('');
    if (surfaceTokens) rules.push(`${surfaceSelector}{${surfaceTokens}}`);
    // Exposed corners belong to this surface's base plane, not the root canvas.
    // Underlays deliberately receive no artwork or scrim and cannot dim content.
    if (baseToken) rules.push(`${rootSelector} [data-openbitfun-surface-underlay="${cssEscape(surface.surface)}"]{${surfaceTokens}${declaration('background-color', baseOpacity === 1 ? `var(${baseToken})` : baseFill)}}`);
    Object.entries(surface.states ?? {}).forEach(([state, recipe]) => {
      if (recipe && SAFE_STATE.test(state)) rules.push(compileStateRule(surfaceSelector, state, recipe, skin));
    });
  });
  return rules.join('\n');
}

export class VisualSkinRuntime {
  private snapshot: VisualSkinSnapshot = {
    initialized: false,
    status: 'initializing',
    activeSkinId: null,
    previewSkinId: null,
    activeSkin: null,
    projection: null,
    catalog: [],
    invalidRecords: [],
  };
  private readonly listeners = new Set<(snapshot: VisualSkinSnapshot) => void>();
  private readonly projectionWatchers = new Set<() => boolean>();
  private readonly parser = new VisualSkinPackageParser();
  private readonly storage: VisualSkinStorage;
  private initializePromise: Promise<void> | null = null;
  private mutationObserver: MutationObserver | null = null;
  private projectionObserver: MutationObserver | null = null;
  private projectionRefreshQueued = false;
  private paintRefreshNeeded = false;
  private appliedSkin: StoredVisualSkin | null = null;
  private readonly partImages = new VisualSkinImageResources();

  private skinCss(skin: StoredVisualSkin): string {
    return compileSkinCss(skin, this.partImages.ensure(skin));
  }

  private collectPartImages(): void {
    this.partImages.retain([this.appliedSkin, this.snapshot.activeSkin]);
  }

  constructor(storage: VisualSkinStorage = createVisualSkinStorage()) {
    this.storage = storage;
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  getSnapshot(): VisualSkinSnapshot { return this.snapshot; }

  subscribe(listener: (snapshot: VisualSkinSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Interactive diagnostics are opt-in; CSS already owns live state paint. */
  watchProjection = (isVisible: () => boolean = () => true): (() => void) => {
    this.projectionWatchers.add(isVisible);
    this.queueRefresh(false);
    return () => { this.projectionWatchers.delete(isVisible); };
  };

  async importPackage(source: ArrayBuffer): Promise<VisualSkinCatalogEntry> {
    await this.initialize();
    const parsed = await this.parser.parse(source);
    await this.storage.put(parsed);
    await this.refreshCatalog();
    await this.activate(parsed.manifest.id);
    return toVisualSkinCatalogEntry(parsed);
  }

  async activate(id: string): Promise<void> {
    await this.initialize();
    await this.applySelection(id);
  }

  async preview(id: string): Promise<void> {
    await this.initialize();
    const skin = await this.storage.get(id);
    if (!skin) throw new Error(`Visual skin is not installed: ${id}`);
    this.setSnapshot({ status: 'applying', error: undefined });
    try {
      this.appliedSkin = skin;
      document.documentElement.setAttribute(ACTIVE_ID_ATTRIBUTE, skin.manifest.id);
      this.syncSurfaceMarkers(skin);
      this.replaceStyle(this.skinCss(skin));
      this.setSnapshot({ previewSkinId: skin.manifest.id, projection: createProjectionReport(skin), status: 'previewing', error: undefined });
      this.collectPartImages();
    } catch (error) {
      const restore = this.snapshot.activeSkin;
      if (restore) {
        this.appliedSkin = restore;
        document.documentElement.setAttribute(ACTIVE_ID_ATTRIBUTE, restore.manifest.id);
        this.syncSurfaceMarkers(restore);
        this.replaceStyle(this.skinCss(restore));
      } else {
        this.clearAppliedSkin();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setSnapshot({ previewSkinId: null, projection: restore ? createProjectionReport(restore) : null, status: restore ? 'ready' : 'degraded', error: message });
      this.collectPartImages();
      throw error;
    }
  }

  async cancelPreview(): Promise<void> {
    await this.initialize();
    if (!this.snapshot.previewSkinId) return;
    this.restoreDisplay(this.snapshot.activeSkin);
    this.setSnapshot({ previewSkinId: null, projection: this.appliedSkin ? createProjectionReport(this.appliedSkin) : null, status: 'ready', error: undefined });
    this.collectPartImages();
  }

  private restoreDisplay(skin: StoredVisualSkin | null): void {
    if (!skin) { this.clearAppliedSkin(); return; }
    this.appliedSkin = skin;
    document.documentElement.setAttribute(ACTIVE_ID_ATTRIBUTE, skin.manifest.id);
    this.syncSurfaceMarkers(skin);
    this.replaceStyle(this.skinCss(skin));
  }

  private async applySelection(id: string): Promise<void> {
    const before = this.snapshot;
    const previousSkin = this.appliedSkin;
    let committed = false;
    try {
      const skin = await this.storage.get(id);
      if (!skin) throw new Error(`Visual skin is not installed: ${id}`);
      this.partImages.ensure(skin);
      // Selection writes are transactional. Do not touch the visible skin
      // until IndexedDB confirms that the selection has committed.
      this.setSnapshot({ status: 'applying', error: undefined });
      await this.storage.setSelection(id);
      committed = true;
      this.appliedSkin = skin;
      document.documentElement.setAttribute(ACTIVE_ID_ATTRIBUTE, id);
      this.syncSurfaceMarkers(skin);
      this.replaceStyle(this.skinCss(skin));
      this.setSnapshot({ initialized: true, activeSkinId: id, activeSkin: skin, previewSkinId: null, projection: createProjectionReport(skin), status: 'ready', error: undefined });
      this.collectPartImages();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Visual skin activation failed', { skinId: id, error: message });
      if (committed) {
        await this.storage.setSelection(before.activeSkinId);
        this.clearAppliedSkin();
        if (previousSkin) {
          this.appliedSkin = previousSkin;
          document.documentElement.setAttribute(ACTIVE_ID_ATTRIBUTE, previousSkin.manifest.id);
          this.syncSurfaceMarkers(previousSkin);
          this.replaceStyle(this.skinCss(previousSkin));
        }
      }
      this.setSnapshot({ ...before, error: message });
      this.collectPartImages();
      throw error;
    }
  }

  async remove(id: IDBValidKey): Promise<void> {
    await this.initialize();
    try {
      // The storage transaction owns both deletion and selection clearing.
      // A rejected transaction leaves the display, snapshot and catalog intact.
      await this.storage.delete(id);
    } catch (error) {
      this.setSnapshot({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const wasActive = this.snapshot.activeSkinId === id;
    const wasPreview = this.snapshot.previewSkinId === id;
    const activeSkin = wasActive ? null : this.snapshot.activeSkin;
    const previewSkinId = wasPreview ? null : this.snapshot.previewSkinId;
    if (wasPreview || (wasActive && !previewSkinId)) this.restoreDisplay(activeSkin);
    this.setSnapshot({
      activeSkinId: activeSkin?.manifest.id ?? null,
      activeSkin,
      previewSkinId,
      catalog: this.snapshot.catalog.filter(entry => entry.id !== id),
      invalidRecords: this.snapshot.invalidRecords.filter(record => record.key !== id),
      projection: this.appliedSkin ? createProjectionReport(this.appliedSkin) : null,
      status: previewSkinId ? 'previewing' : 'ready',
      error: undefined,
    });
    this.collectPartImages();
  }

  private async initializeInternal(): Promise<void> {
    try {
      await this.refreshCatalog();
      const selection = await this.storage.getSelection();
      if (selection && this.snapshot.catalog.some(entry => entry.id === selection)) await this.applySelection(selection);
      else if (selection && this.snapshot.invalidRecords.some(record => record.key === selection)) {
        this.setSnapshot({ initialized: true, status: 'degraded', error: `Selected visual skin record is invalid: ${selection}` });
      } else {
        if (selection) await this.storage.setSelection(null);
        this.setSnapshot({ initialized: true, status: 'ready', activeSkinId: null, activeSkin: null, previewSkinId: null, projection: null });
      }
      this.mutationObserver = new MutationObserver(() => this.queueRefresh(true));
      this.mutationObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-scheme', 'data-contrast'] });
      if (document.body) {
        this.projectionObserver = new MutationObserver(records => {
          let repaint = false, diagnose = false;
          for (const record of records) {
            if (record.type === 'attributes') {
              diagnose = true;
              if (PAINT_ATTRIBUTES.includes(record.attributeName!)) repaint = true;
            } else if ([...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(PAINT_TARGET_SELECTOR) || node.querySelector(PAINT_TARGET_SELECTOR)))) {
              repaint = true;
            }
          }
          if (repaint || diagnose) this.queueRefresh(repaint);
        });
        this.projectionObserver.observe(document.body, {
          attributes: true,
          attributeFilter: [...PAINT_ATTRIBUTES, 'data-disabled', 'data-invalid', 'data-selected', 'data-openbitfun-state', 'aria-selected', 'aria-pressed', 'aria-current', 'aria-disabled', 'aria-checked', 'aria-expanded', 'aria-invalid', 'aria-readonly', 'aria-required', 'aria-busy', 'disabled', 'checked', 'open', 'readonly', 'required'],
          childList: true, subtree: true,
        });
        for (const name of ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'focusin', 'focusout', 'change', 'input', 'keydown', 'keyup', 'reset']) {
          document.body.addEventListener(name, this.queueProjectionRefresh, true);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setSnapshot({ initialized: true, status: 'degraded', error: message });
    }
  }

  private queueProjectionRefresh = (): void => {
    this.queueRefresh(false);
  };

  private queueRefresh(repaint: boolean): void {
    if (!repaint && ![...this.projectionWatchers].some(isVisible => isVisible())) return;
    this.paintRefreshNeeded ||= repaint;
    if (this.projectionRefreshQueued || !this.appliedSkin) return;
    this.projectionRefreshQueued = true;
    queueMicrotask(() => {
      this.projectionRefreshQueued = false;
      const repaint = this.paintRefreshNeeded;
      this.paintRefreshNeeded = false;
      if (!this.appliedSkin) return;
      // Native CSS selectors own interactive paint. State changes update only
      // diagnostics; ownership/mode changes are the only reasons to recompile.
      if (repaint) {
        this.syncSurfaceMarkers(this.appliedSkin);
        this.replaceStyle(this.skinCss(this.appliedSkin));
      }
      const projection = createProjectionReport(this.appliedSkin);
      if (JSON.stringify(projection) !== JSON.stringify(this.snapshot.projection)) this.setSnapshot({ projection });
    });
  }

  dispose(): void {
    this.mutationObserver?.disconnect();
    this.projectionObserver?.disconnect();
    for (const name of ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'focusin', 'focusout', 'change', 'input', 'keydown', 'keyup', 'reset']) {
      document.body?.removeEventListener(name, this.queueProjectionRefresh, true);
    }
    this.clearAppliedSkin();
    this.partImages.retain([]);
    this.projectionWatchers.clear();
    this.listeners.clear();
  }

  private async refreshCatalog(): Promise<void> {
    const listing = await this.storage.list();
    this.setSnapshot({ catalog: listing.skins.map(toVisualSkinCatalogEntry), invalidRecords: listing.invalidRecords });
  }

  private replaceStyle(cssText: string): void {
    const existing = document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);
    if (existing?.textContent === cssText) return;
    // Keep the stylesheet attached while owners mount or stream new parts.
    // Removing it invalidates the artwork and all surface paint together.
    if (existing) { existing.textContent = cssText; return; }
    const style = document.createElement('style');
    style.setAttribute(STYLE_ATTRIBUTE, 'true');
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  private clearAppliedSkin(): void {
    document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`).forEach(node => node.remove());
    document.querySelectorAll(`[${SURFACE_ATTRIBUTE}]`).forEach(node => node.removeAttribute(SURFACE_ATTRIBUTE));
    document.querySelectorAll(`[${ARTWORK_ATTRIBUTE}]`).forEach(node => node.removeAttribute(ARTWORK_ATTRIBUTE));
    document.querySelectorAll(`[${BACKGROUND_SOURCE_ATTRIBUTE}]`).forEach(node => node.removeAttribute(BACKGROUND_SOURCE_ATTRIBUTE));
    document.querySelectorAll(`[${SKIN_NODE_ATTRIBUTE}]`).forEach(node => node.removeAttribute(SKIN_NODE_ATTRIBUTE));
    document.documentElement.removeAttribute(ACTIVE_ID_ATTRIBUTE);
    this.appliedSkin = null;
  }

  private syncSurfaceMarkers(skin: StoredVisualSkin | null): void {
    const attributes = [SURFACE_ATTRIBUTE, ARTWORK_ATTRIBUTE, BACKGROUND_SOURCE_ATTRIBUTE];
    const desired = new Map<Element, Record<string, string>>();
    if (skin) resolveSkinSurfaces(skin, currentMode()).selected.map(entry => entry.surface).filter(surface => isVisualSkinSurfaceId(surface.surface)).forEach(profile => {
      const asset = profile.backgroundAssetId ? skin.assets[profile.backgroundAssetId] : undefined;
      const sharedBackdrop = profile.backgroundSource === 'shell' && hasShellArtwork(skin, currentMode());
      const hasArtwork = sharedBackdrop || Boolean(asset?.dataUrl && (profile.backgroundOpacity ?? 1) > 0);
      document.querySelectorAll(`[data-openbitfun-surface="${cssEscape(profile.surface)}"]`).forEach(node => {
        desired.set(node, {
          [SURFACE_ATTRIBUTE]: profile.surface,
          ...(hasArtwork ? { [ARTWORK_ATTRIBUTE]: 'true' } : {}),
          ...(sharedBackdrop ? { [BACKGROUND_SOURCE_ATTRIBUTE]: 'shell' } : {}),
        });
      });
    });
    // Reconcile stale owners too, without clearing unchanged artwork markers.
    const nodes = new Set([...document.querySelectorAll(attributes.map(name => `[${name}]`).join(',')), ...desired.keys()]);
    for (const node of nodes) {
      for (const name of attributes) {
        const value = desired.get(node)?.[name] ?? null;
        if (node.getAttribute(name) === value) continue;
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    }
  }

  private setSnapshot(patch: Partial<VisualSkinSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener(this.snapshot));
  }
}
