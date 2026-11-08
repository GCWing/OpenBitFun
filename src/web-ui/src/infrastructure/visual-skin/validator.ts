import { isVisualSkinSlotId, isVisualSkinSurfaceId, VISUAL_SKIN_TOKEN_VARIABLES, VISUAL_SKIN_PART_FIELDS, VISUAL_SKIN_SURFACE_FIELDS, VISUAL_SKIN_BACKGROUND_POSITION, isVisualSkinBackgroundSize } from './contract';
import { MAX_SKIN_ASSET_BYTES } from './archive';
import {
  VISUAL_SKIN_SCHEMA,
  VISUAL_SKIN_SCHEMA_VERSION,
  type VisualSkinPackage,
  type VisualSkinValidationIssue,
  type VisualSkinValidationResult,
} from './types';

const allowedTokenNames = new Set(Object.keys(VISUAL_SKIN_TOKEN_VARIABLES));
const forbiddenValue = /(?:url\s*\(|var\s*\(|expression\s*\(|[;{}<>])/i;
const safeId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const safeSlot = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
// Product-owned parts include names such as contextBar and pageHeader. Keep
// their exact spelling without relaxing global surface, slot or component ids.
const safePart = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const safeState = /^[a-z][a-z0-9_-]{0,48}$/;
const safeBackgroundPosition = /^(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%)(?:\s+(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%))?$/;
const supportedMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function issue(
  path: string,
  message: string,
  severity: VisualSkinValidationIssue['severity'] = 'error',
): VisualSkinValidationIssue {
  return { path, message, severity };
}

function validateTokenMap(
  value: unknown,
  path: string,
  errors: VisualSkinValidationIssue[],
): void {
  if (!isRecord(value)) {
    errors.push(issue(path, 'must be an object'));
    return;
  }
  Object.entries(value).forEach(([name, tokenValue]) => {
    if (!allowedTokenNames.has(name)) {
      errors.push(issue(`${path}.${name}`, 'is not a public theme token'));
    }
    if (typeof tokenValue !== 'string' && typeof tokenValue !== 'number') {
      errors.push(issue(`${path}.${name}`, 'must be a string or number'));
      return;
    }
    if (typeof tokenValue === 'string') {
      if (tokenValue.length === 0 || tokenValue.length > 512) {
        errors.push(issue(`${path}.${name}`, 'must be between 1 and 512 characters'));
      }
      if (forbiddenValue.test(tokenValue)) {
        errors.push(issue(`${path}.${name}`, 'contains a forbidden CSS value'));
      }
    } else if (!Number.isFinite(tokenValue)) {
      errors.push(issue(`${path}.${name}`, 'must be finite'));
    }
  });
}

/**
 * Named visual slots intentionally have their own namespace. They are emitted
 * as --openbitfun-skin-slot-* variables by the runtime and therefore must not
 * be able to smuggle arbitrary CSS or selectors into the document.
 */
function validateSlotTokenMap(
  value: unknown,
  path: string,
  errors: VisualSkinValidationIssue[],
): void {
  if (!isRecord(value)) {
    errors.push(issue(path, 'must be an object'));
    return;
  }
  Object.entries(value).forEach(([name, tokenValue]) => {
    if (!safeSlot.test(name)) errors.push(issue(`${path}.${name}`, 'has an invalid slot token id'));
    if (typeof tokenValue !== 'string' && typeof tokenValue !== 'number') {
      errors.push(issue(`${path}.${name}`, 'must be a string or number'));
      return;
    }
    if (typeof tokenValue === 'string') {
      if (tokenValue.length === 0 || tokenValue.length > 512) {
        errors.push(issue(`${path}.${name}`, 'must be between 1 and 512 characters'));
      }
      if (forbiddenValue.test(tokenValue)) {
        errors.push(issue(`${path}.${name}`, 'contains a forbidden CSS value'));
      }
    } else if (!Number.isFinite(tokenValue)) {
      errors.push(issue(`${path}.${name}`, 'must be finite'));
    }
  });
}

function validateDataUrl(
  value: string,
  mimeType: string,
  path: string,
  errors: VisualSkinValidationIssue[],
): void {
  const prefix = `data:${mimeType};base64,`;
  if (!value.startsWith(prefix) || value.length > prefix.length + Math.ceil(MAX_SKIN_ASSET_BYTES / 3) * 4) {
    errors.push(issue(path, `must be a base64 data URL for ${mimeType}`));
    return;
  }
  const payload = value.slice(prefix.length);
  if (payload.length === 0 || !/^[a-z0-9+/]*={0,2}$/i.test(payload)) {
    errors.push(issue(path, 'contains invalid base64 data'));
    return;
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  if (Math.floor(payload.length * 3 / 4) - padding > MAX_SKIN_ASSET_BYTES) errors.push(issue(path, 'exceeds the asset size limit'));
}

export function validateVisualSkinPackage(raw: unknown): VisualSkinValidationResult {
  const errors: VisualSkinValidationIssue[] = [];
  const warnings: VisualSkinValidationIssue[] = [];
  if (!isRecord(raw)) return { valid: false, errors: [issue('$', 'must be an object')], warnings };
  const surfaceGroups = [
    { value: raw.surfaces, path: 'surfaces' },
    ...Object.entries(isRecord(raw.modes) ? raw.modes : {}).flatMap(([mode, patch]) =>
      isRecord(patch) ? [{ value: patch.surfaces, path: `modes.${mode}.surfaces` }] : []),
  ];
  const manifest = raw.manifest;
  if (!isRecord(manifest)) {
    errors.push(issue('manifest', 'is required'));
  } else {
    if (manifest.schema !== VISUAL_SKIN_SCHEMA) errors.push(issue('manifest.schema', `must be ${VISUAL_SKIN_SCHEMA}`));
    if (manifest.schemaVersion !== VISUAL_SKIN_SCHEMA_VERSION) errors.push(issue('manifest.schemaVersion', `must be ${VISUAL_SKIN_SCHEMA_VERSION}`));
    if (typeof manifest.id !== 'string' || !safeId.test(manifest.id) || manifest.id.length > 96) errors.push(issue('manifest.id', 'must be a safe id of at most 96 characters'));
    for (const field of ['name', 'version'] as const) {
      if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0 || manifest[field].length > 160) {
        errors.push(issue(`manifest.${field}`, 'must be a non-empty string of at most 160 characters'));
      }
    }
  }

  if (!isRecord(raw.modes) || Object.keys(raw.modes).length === 0) {
    errors.push(issue('modes', 'must contain at least one mode'));
  } else {
    const supportedModes = new Set(['light', 'dark', 'highContrastLight', 'highContrastDark']);
    Object.entries(raw.modes).forEach(([mode, patch]) => {
      if (!supportedModes.has(mode)) errors.push(issue(`modes.${mode}`, 'is not a supported mode'));
      if (!isRecord(patch)) {
        errors.push(issue(`modes.${mode}`, 'must be an object'));
        return;
      }
      if (patch.tokens !== undefined) validateTokenMap(patch.tokens, `modes.${mode}.tokens`, errors);
      if (patch.slots !== undefined) {
        if (!isRecord(patch.slots)) errors.push(issue(`modes.${mode}.slots`, 'must be an object'));
        else Object.entries(patch.slots).forEach(([slot, tokens]) => {
          if (!safeSlot.test(slot)) errors.push(issue(`modes.${mode}.slots.${slot}`, 'has an invalid slot id'));
          else if (!isVisualSkinSlotId(slot)) warnings.push(issue(`modes.${mode}.slots.${slot}`, 'is outside the current product slot contract', 'warning'));
          validateSlotTokenMap(tokens, `modes.${mode}.slots.${slot}`, errors);
        });
      }
    });
  }

  if (raw.assets !== undefined) {
    if (!isRecord(raw.assets)) errors.push(issue('assets', 'must be an object'));
    else Object.entries(raw.assets).forEach(([assetId, asset]) => {
      const path = `assets.${assetId}`;
      if (!safeId.test(assetId)) errors.push(issue(path, 'has an invalid asset id'));
      if (!isRecord(asset)) {
        errors.push(issue(path, 'must be an object'));
        return;
      }
      if (typeof asset.mimeType !== 'string' || !supportedMimeTypes.has(asset.mimeType)) errors.push(issue(`${path}.mimeType`, 'is not a supported image MIME type'));
      if (!isRecord(asset.source)) {
        errors.push(issue(`${path}.source`, 'must be an object'));
      } else if (asset.source.kind === 'data') {
        if (typeof asset.source.data !== 'string' || typeof asset.mimeType !== 'string') errors.push(issue(`${path}.source.data`, 'must be a data URL'));
        else validateDataUrl(asset.source.data, asset.mimeType, `${path}.source.data`, errors);
      } else if (asset.source.kind === 'path') {
        const pathSegments = typeof asset.source.path === 'string' ? asset.source.path.split('/') : [];
        if (typeof asset.source.path !== 'string' || asset.source.path.length === 0 || asset.source.path.includes('\\') || asset.source.path.startsWith('/') || pathSegments.some(segment => segment === '' || segment === '.' || segment === '..')) {
          errors.push(issue(`${path}.source.path`, 'must be a safe relative package path'));
        }
      } else {
        errors.push(issue(`${path}.source.kind`, 'must be data or path'));
      }
    });
  }

  if (raw.components !== undefined) {
    if (!Array.isArray(raw.components)) errors.push(issue('components', 'must be an array'));
    else raw.components.forEach((component, index) => {
      const path = `components[${index}]`;
      if (!isRecord(component) || typeof component.component !== 'string' || !safeSlot.test(component.component)) {
        errors.push(issue(path, 'must contain a safe component id'));
        return;
      }
      if (component.tokens !== undefined) validateTokenMap(component.tokens, `${path}.tokens`, errors);
      for (const key of Object.keys(component)) {
        if (!['component', 'tokens', 'slots', 'states'].includes(key)) errors.push(issue(`${path}.${key}`, 'is not a supported component field'));
      }
      if (component.slots !== undefined) validatePartMap(component.slots, `${path}.slots`, errors);
      if (component.states !== undefined) validateStateMap(component.states, `${path}.states`, errors, component.slots);

    });
  }

  for (const { value, path: groupPath } of surfaceGroups.filter(group => group.value !== undefined)) {
    if (!Array.isArray(value)) errors.push(issue(groupPath, 'must be an array'));
    else value.forEach((surface, index) => {
      const path = `${groupPath}[${index}]`;
      if (!isRecord(surface) || typeof surface.surface !== 'string' || !safeSlot.test(surface.surface)) errors.push(issue(path, 'must contain a safe surface id'));
      else {
        for (const key of Object.keys(surface)) {
          if (!(VISUAL_SKIN_SURFACE_FIELDS as readonly string[]).includes(key)) errors.push(issue(`${path}.${key}`, 'is not a supported surface field'));
        }
        if (!isVisualSkinSurfaceId(surface.surface)) warnings.push(issue(`${path}.surface`, 'is outside the current product surface contract', 'warning'));
        if (surface.baseToken !== undefined && (typeof surface.baseToken !== 'string' || !allowedTokenNames.has(surface.baseToken))) errors.push(issue(`${path}.baseToken`, 'must reference a public theme token'));
        if (surface.backgroundAssetId !== undefined && (typeof surface.backgroundAssetId !== 'string' || !safeId.test(surface.backgroundAssetId))) errors.push(issue(`${path}.backgroundAssetId`, 'must reference a safe asset id'));
        if (surface.fit !== undefined && !['cover', 'contain', 'fill'].includes(String(surface.fit))) {
          errors.push(issue(`${path}.fit`, 'must be cover, contain, or fill'));
        }
        if (surface.backgroundPosition !== undefined && (typeof surface.backgroundPosition !== 'string' || surface.backgroundPosition.length > 64 || !safeBackgroundPosition.test(surface.backgroundPosition))) {
          errors.push(issue(`${path}.backgroundPosition`, 'must use safe position keywords or percentages'));
        }
        if (surface.backgroundSource !== undefined) {
          if (surface.backgroundSource !== 'shell') errors.push(issue(`${path}.backgroundSource`, 'must be shell'));
          if (surface.surface === 'shell') errors.push(issue(`${path}.backgroundSource`, 'shell cannot inherit itself'));
          for (const field of ['backgroundAssetId', 'backgroundPosition', 'backgroundOpacity', 'fit']) {
            if (surface[field] !== undefined) errors.push(issue(`${path}.${field}`, 'cannot be combined with backgroundSource'));
          }
        }
        for (const field of ['baseOpacity', 'backgroundOpacity', 'scrimOpacity'] as const) {
          if (surface[field] !== undefined && (typeof surface[field] !== 'number' || !Number.isFinite(surface[field]) || surface[field] < 0 || surface[field] > 1)) {
            errors.push(issue(`${path}.${field}`, 'must be between 0 and 1'));
          }
        }
        if (surface.scrimToken !== undefined && (typeof surface.scrimToken !== 'string' || !allowedTokenNames.has(surface.scrimToken))) errors.push(issue(`${path}.scrimToken`, 'must reference a public theme token'));
        if (surface.tokens !== undefined) validateTokenMap(surface.tokens, `${path}.tokens`, errors);
        if (surface.states !== undefined) validateStateMap(surface.states, `${path}.states`, errors);
      }
    });
  }

  // References are checked after their declarations so imports fail closed
  // instead of silently dropping a decorative recipe at render time.
  if (isRecord(raw.assets)) {
    const assetIds = new Set(Object.keys(raw.assets));
    if (isRecord(manifest) && manifest.previewAssetId !== undefined
      && (typeof manifest.previewAssetId !== 'string' || !assetIds.has(manifest.previewAssetId))) {
      errors.push(issue('manifest.previewAssetId', 'must reference a declared asset'));
    }
    if (Array.isArray(raw.components)) {
      raw.components.forEach((component, index) => {
        if (!isRecord(component)) return;
        if (isRecord(component.slots)) Object.entries(component.slots).forEach(([slot, recipe]) => {
          if (isRecord(recipe) && typeof recipe.assetId === 'string' && !assetIds.has(recipe.assetId)) {
            errors.push(issue(`components[${index}].slots.${slot}.assetId`, 'must reference a declared asset'));
          }
        });
        if (isRecord(component.states)) {
          Object.entries(component.states).forEach(([state, stateRecipe]) => {
            if (!isRecord(stateRecipe) || !isRecord(stateRecipe.slots)) return;
            Object.entries(stateRecipe.slots).forEach(([slot, recipe]) => {
              if (isRecord(recipe) && typeof recipe.assetId === 'string' && !assetIds.has(recipe.assetId)) {
                errors.push(issue(`components[${index}].states.${state}.slots.${slot}.assetId`, 'must reference a declared asset'));
              }
            });
          });
        }
      });
    }
    for (const { value, path: groupPath } of surfaceGroups) {
      if (!Array.isArray(value)) continue;
      value.forEach((surface, index) => {
        if (isRecord(surface) && typeof surface.backgroundAssetId === 'string' && !assetIds.has(surface.backgroundAssetId)) {
          errors.push(issue(`${groupPath}[${index}].backgroundAssetId`, 'must reference a declared asset'));
        }
        if (!isRecord(surface) || !isRecord(surface.states)) return;
        Object.entries(surface.states).forEach(([state, stateRecipe]) => {
          if (!isRecord(stateRecipe) || !isRecord(stateRecipe.slots)) return;
          Object.entries(stateRecipe.slots).forEach(([slot, recipe]) => {
            if (isRecord(recipe) && typeof recipe.assetId === 'string' && !assetIds.has(recipe.assetId)) {
              errors.push(issue(`${groupPath}[${index}].states.${state}.slots.${slot}.assetId`, 'must reference a declared asset'));
            }
          });
        });
      });
    }
  } else if (isRecord(manifest) && manifest.previewAssetId !== undefined) {
    errors.push(issue('manifest.previewAssetId', 'requires an assets object'));
  }

  if (!isRecord(raw.assets)) {
    if (Array.isArray(raw.components)) {
      raw.components.forEach((component, index) => {
        if (!isRecord(component)) return;
        if (isRecord(component.slots)) Object.entries(component.slots).forEach(([slot, recipe]) => {
          if (isRecord(recipe) && typeof recipe.assetId === 'string') {
            errors.push(issue(`components[${index}].slots.${slot}.assetId`, 'requires an assets object'));
          }
        });
        if (isRecord(component.states)) {
          Object.entries(component.states).forEach(([state, stateRecipe]) => {
            if (!isRecord(stateRecipe) || !isRecord(stateRecipe.slots)) return;
            Object.entries(stateRecipe.slots).forEach(([slot, recipe]) => {
              if (isRecord(recipe) && typeof recipe.assetId === 'string') {
                errors.push(issue(`components[${index}].states.${state}.slots.${slot}.assetId`, 'requires an assets object'));
              }
            });
          });
        }
      });
    }
    for (const { value, path: groupPath } of surfaceGroups) {
      if (!Array.isArray(value)) continue;
      value.forEach((surface, index) => {
        if (isRecord(surface) && typeof surface.backgroundAssetId === 'string') {
          errors.push(issue(`${groupPath}[${index}].backgroundAssetId`, 'requires an assets object'));
        }
        if (!isRecord(surface) || !isRecord(surface.states)) return;
        Object.entries(surface.states).forEach(([state, stateRecipe]) => {
          if (!isRecord(stateRecipe) || !isRecord(stateRecipe.slots)) return;
          Object.entries(stateRecipe.slots).forEach(([slot, recipe]) => {
            if (isRecord(recipe) && typeof recipe.assetId === 'string') {
              errors.push(issue(`${groupPath}[${index}].states.${state}.slots.${slot}.assetId`, 'requires an assets object'));
            }
          });
        });
      });
    }
  }

  const value = errors.length === 0 ? raw as unknown as VisualSkinPackage : undefined;
  return { valid: errors.length === 0, errors, warnings, value };
}

function validatePartMap(value: unknown, path: string, errors: VisualSkinValidationIssue[]): void {
  if (!isRecord(value)) { errors.push(issue(path, 'must be an object')); return; }
  Object.entries(value).forEach(([part, recipe]) => {
    if (!safePart.test(part)) errors.push(issue(`${path}.${part}`, 'has an invalid part id'));
    validatePart(recipe, `${path}.${part}`, errors);
  });
}

function validatePart(value: unknown, path: string, errors: VisualSkinValidationIssue[], base?: unknown): void {
  if (!isRecord(value)) { errors.push(issue(path, 'must be an object')); return; }
  for (const key of Object.keys(value)) if (!(VISUAL_SKIN_PART_FIELDS as readonly string[]).includes(key)) errors.push(issue(`${path}.${key}`, 'is not a supported part paint field'));
  if (value.assetId !== undefined && value.assetId !== null && (typeof value.assetId !== 'string' || !safeId.test(value.assetId))) errors.push(issue(`${path}.assetId`, 'must reference an asset id, or null to clear artwork'));
  if (value.fit !== undefined && !['cover', 'contain', 'fill'].includes(String(value.fit))) errors.push(issue(`${path}.fit`, 'must be cover, contain, or fill'));
  if (value.backgroundSize !== undefined && !isVisualSkinBackgroundSize(value.backgroundSize)) errors.push(issue(`${path}.backgroundSize`, 'must contain one or two auto, bounded px or percentage sizes'));
  if (value.fit !== undefined && value.backgroundSize !== undefined) errors.push(issue(`${path}.backgroundSize`, 'cannot be combined with fit'));
  if (value.backgroundPosition !== undefined && (typeof value.backgroundPosition !== 'string' || !VISUAL_SKIN_BACKGROUND_POSITION.test(value.backgroundPosition))) errors.push(issue(`${path}.backgroundPosition`, 'must use bounded keywords or percentages'));
  if (value.backgroundRepeat !== undefined && !['no-repeat','repeat','repeat-x','repeat-y'].includes(String(value.backgroundRepeat))) errors.push(issue(`${path}.backgroundRepeat`, 'is not a supported repeat mode'));
  if (value.backgroundOpacity !== undefined && (typeof value.backgroundOpacity !== 'number' || !Number.isFinite(value.backgroundOpacity) || value.backgroundOpacity < 0 || value.backgroundOpacity > 1)) errors.push(issue(`${path}.backgroundOpacity`, 'must be between 0 and 1'));
  for (const key of ['backgroundToken','foregroundToken','borderToken','shadowToken','textShadowToken']) {
    const token = value[key];
    if (token !== undefined && (typeof token !== 'string' || !allowedTokenNames.has(token) || ((key === 'shadowToken' || key === 'textShadowToken') ? !token.startsWith('shadow.') : !token.startsWith('color.') && !token.startsWith('component.')))) errors.push(issue(`${path}.${key}`, 'must reference a public token for this paint property'));
  }
  const merged = { ...(isRecord(base) ? base : {}), ...value };
  for (const key of ['fit','backgroundSize','backgroundPosition','backgroundRepeat','backgroundOpacity']) {
    if (value[key] !== undefined && typeof merged.assetId !== 'string') errors.push(issue(`${path}.${key}`, 'requires assetId in this recipe or its base part'));
  }
  if (value.backgroundOpacity !== undefined && !merged.backgroundToken) errors.push(issue(`${path}.backgroundOpacity`, 'requires an opaque backgroundToken for image-only composition'));
}

function validateStateMap(value: unknown, path: string, errors: VisualSkinValidationIssue[], baseSlots?: unknown): void {
  if (!isRecord(value)) {
    errors.push(issue(path, 'must be an object'));
    return;
  }
  Object.entries(value).forEach(([state, recipe]) => {
    if (!safeState.test(state)) {
      errors.push(issue(`${path}.${state}`, 'must be a bounded product interaction state id'));
      return;
    }
    if (!isRecord(recipe)) {
      errors.push(issue(`${path}.${state}`, 'must be an object'));
      return;
    }
    if (recipe.tokens !== undefined) validateTokenMap(recipe.tokens, `${path}.${state}.tokens`, errors);
    if (recipe.slots !== undefined) {
      if (!isRecord(recipe.slots)) errors.push(issue(`${path}.${state}.slots`, 'must be an object'));
      else Object.entries(recipe.slots).forEach(([slot, slotRecipe]) => {
        if (!safePart.test(slot)) errors.push(issue(`${path}.${state}.slots.${slot}`, 'has an invalid part id'));
        if (!isRecord(slotRecipe)) {
          errors.push(issue(`${path}.${state}.slots.${slot}`, 'must be an object'));
          return;
        }
        validatePart(slotRecipe, `${path}.${state}.slots.${slot}`, errors, isRecord(baseSlots) ? baseSlots[slot] : undefined);
      });
    }
  });
}

export function assertValidVisualSkinPackage(raw: unknown): VisualSkinPackage {
  const result = validateVisualSkinPackage(raw);
  if (!result.valid) throw new Error(result.errors.map(error => `${error.path}: ${error.message}`).join('; '));
  return result.value!;
}
