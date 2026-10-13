import { RemoteModelCatalog, RemoteModelConfig } from '../../model/RemoteModels';
import {
  RemoteModelDefaultsRole,
  RemoteModelDefaultsRoles
} from '../../services/RemoteModelDefaultsController';

/**
 * The vocabulary the two device-model pages share.
 *
 * Which models a role may be set to, which of them the picker offers, and what a
 * role row says are one reading of one catalog, so they are decided here as pure
 * functions over it: no i18n lookup, no controller, no ArkUI. The pages resolve
 * the keys this returns and own every pixel.
 *
 * The desktop is the authority. A role's value is whatever the last device read
 * returned; a candidate is a model the desktop itself lists as enabled and
 * capable, in the desktop's own order. Nothing here reorders, renames or repairs
 * that list.
 */

/** What one role row of the device model settings page shows. */
export interface ModelRoleRowProjection {
  /** The model the role points at; empty when the role has no model of its own. */
  modelId: string;
  /** The catalog entry for `modelId`, when the desktop still lists it. */
  model: RemoteModelConfig | undefined;
  /** The role has no model of its own: `fast` follows the primary, the rest are off. */
  unset: boolean;
  /** The value line's placeholder key; empty while `modelId` names a model. */
  unsetKey: string;
  /** The hint under the value; empty unless the role explicitly falls back. */
  hintKey: string;
  /**
   * The role resolves to an enabled model the desktop lists — its own, or for
   * `fast` the primary it falls back to. This is what the row's leading mark
   * states.
   */
  resolved: boolean;
}

export class ModelRoleCandidatesPolicy {
  /** Model capabilities, as the desktop reports them. */
  static readonly CAPABILITY_TEXT_CHAT: string = 'text_chat';
  static readonly CAPABILITY_IMAGE_UNDERSTANDING: string = 'image_understanding';

  /** The neutral "nothing is set here" value, shared with the model panels. */
  static readonly NOT_CONFIGURED_KEY: string = 'settings.modelService.notConfigured';

  /**
   * Models the picker may offer for a role: enabled, capable, in catalog order.
   *
   * A disabled model is not a candidate at all — the desktop would refuse the
   * write, and offering it would turn a filter into an error message — and the
   * capability is what makes the model usable for that role in the first place.
   */
  static textChatCandidates(catalog: RemoteModelCatalog): RemoteModelConfig[] {
    return ModelRoleCandidatesPolicy.capableModels(
      catalog, ModelRoleCandidatesPolicy.CAPABILITY_TEXT_CHAT);
  }

  static imageUnderstandingCandidates(catalog: RemoteModelCatalog): RemoteModelConfig[] {
    return ModelRoleCandidatesPolicy.capableModels(
      catalog, ModelRoleCandidatesPolicy.CAPABILITY_IMAGE_UNDERSTANDING);
  }

  static candidatesForRole(
    role: RemoteModelDefaultsRole,
    catalog: RemoteModelCatalog
  ): RemoteModelConfig[] {
    return role === 'image_understanding' ?
      ModelRoleCandidatesPolicy.imageUnderstandingCandidates(catalog) :
      ModelRoleCandidatesPolicy.textChatCandidates(catalog);
  }

  /** The desktop lists no model at all: the pickers have nothing to offer. */
  static isEmptyCatalog(catalog: RemoteModelCatalog): boolean {
    return catalog.models.length === 0;
  }

  /**
   * Whether the picker offers the "no model" row.
   *
   * The primary model is required — the desktop always resolves one, and a phone
   * that cleared it could leave the device with no model to run — so its picker
   * has no such row. The other two are optional by contract: an empty `fast` is
   * "follow the primary" and an empty `image_understanding` is "off".
   */
  static allowsUnset(role: RemoteModelDefaultsRole): boolean {
    return role !== 'primary';
  }

  /** The pinned row's label key. */
  static unsetLabelKey(role: RemoteModelDefaultsRole): string {
    if (role === 'fast') {
      return 'chat.modelFollowPrimary';
    }
    return ModelRoleCandidatesPolicy.NOT_CONFIGURED_KEY;
  }

  /** The pinned row's hint key. */
  static unsetHintKey(role: RemoteModelDefaultsRole): string {
    if (role === 'fast') {
      return 'chat.modelFastNotConfigured';
    }
    if (role === 'image_understanding') {
      return 'settings.model.imageUnderstandingUnset';
    }
    return '';
  }

  /** The role's own label, shared by the rows, the picker title and the sent row. */
  static roleLabelKey(role: RemoteModelDefaultsRole): string {
    if (role === 'primary') {
      return 'chat.modelPrimary';
    }
    if (role === 'fast') {
      return 'chat.modelFast';
    }
    if (role === 'image_understanding') {
      return 'chat.modelImage';
    }
    return '';
  }

  /** The filter sentence above the candidate list, templated with the device name. */
  static filterKey(role: RemoteModelDefaultsRole): string {
    return role === 'image_understanding' ?
      'settings.model.filterImageUnderstanding' : 'settings.model.filterTextChat';
  }

  /**
   * The capability badge belongs to the multimodal picker only: it explains why
   * that list is short, and on any other page it would only widen every row.
   */
  static showsCapabilityBadge(role: RemoteModelDefaultsRole): boolean {
    return role === 'image_understanding';
  }

  /** The model id a role currently holds; empty when it holds none. */
  static selectedValue(roles: RemoteModelDefaultsRoles, role: RemoteModelDefaultsRole): string {
    if (role === 'primary') {
      return roles.primary || '';
    }
    if (role === 'fast') {
      return roles.fast || '';
    }
    if (role === 'image_understanding') {
      return roles.image_understanding || '';
    }
    return '';
  }

  /** True while the role is set to "no model", i.e. the pinned row is the checked one. */
  static isUnsetSelected(roles: RemoteModelDefaultsRoles, role: RemoteModelDefaultsRole): boolean {
    return ModelRoleCandidatesPolicy.allowsUnset(role) &&
      ModelRoleCandidatesPolicy.selectedValue(roles, role).length === 0;
  }

  /** True when this candidate row is the role's current model. */
  static isCandidateSelected(
    roles: RemoteModelDefaultsRoles,
    role: RemoteModelDefaultsRole,
    modelId: string
  ): boolean {
    return ModelRoleCandidatesPolicy.selectedValue(roles, role) === modelId;
  }

  /**
   * One role row of the settings page.
   *
   * An empty catalog is its own answer: with no model on the device there is
   * nothing for any role to point at, so every row states the same unconfigured
   * value and no row claims to resolve. Saying "follows the primary" there would
   * promise a fallback the desktop cannot perform.
   */
  static roleRow(
    roles: RemoteModelDefaultsRoles,
    role: RemoteModelDefaultsRole,
    catalog: RemoteModelCatalog
  ): ModelRoleRowProjection {
    if (ModelRoleCandidatesPolicy.isEmptyCatalog(catalog)) {
      return {
        modelId: '',
        model: undefined,
        unset: true,
        unsetKey: ModelRoleCandidatesPolicy.NOT_CONFIGURED_KEY,
        hintKey: '',
        resolved: false
      };
    }
    const modelId = ModelRoleCandidatesPolicy.selectedValue(roles, role);
    const model = ModelRoleCandidatesPolicy.modelById(catalog, modelId);
    const unset = modelId.length === 0;
    return {
      modelId,
      model,
      unset,
      unsetKey: unset ? ModelRoleCandidatesPolicy.unsetLabelKey(role) : '',
      hintKey: unset ? ModelRoleCandidatesPolicy.unsetHintKey(role) : '',
      resolved: ModelRoleCandidatesPolicy.resolves(roles, role, catalog)
    };
  }

  /**
   * The model a role actually runs: its own, or for `fast` the primary model it
   * falls back to. `image_understanding` has no fallback — an empty one means the
   * capability is off rather than borrowed from another slot.
   *
   * A role only runs an enabled model, so a slot the desktop points at a disabled
   * model resolves to nothing here even though the row still names it. This is
   * the same reading of a catalog the composer's role rows use.
   */
  static resolvedModel(
    roles: RemoteModelDefaultsRoles,
    role: RemoteModelDefaultsRole,
    catalog: RemoteModelCatalog
  ): RemoteModelConfig | undefined {
    const own = ModelRoleCandidatesPolicy.enabledModelById(
      catalog, ModelRoleCandidatesPolicy.selectedValue(roles, role));
    if (own) {
      return own;
    }
    if (role === 'fast') {
      return ModelRoleCandidatesPolicy.enabledModelById(catalog, roles.primary || '');
    }
    return undefined;
  }

  private static resolves(
    roles: RemoteModelDefaultsRoles,
    role: RemoteModelDefaultsRole,
    catalog: RemoteModelCatalog
  ): boolean {
    return ModelRoleCandidatesPolicy.resolvedModel(roles, role, catalog) !== undefined;
  }

  private static enabledModelById(
    catalog: RemoteModelCatalog,
    modelId: string
  ): RemoteModelConfig | undefined {
    const model = ModelRoleCandidatesPolicy.modelById(catalog, modelId);
    return model && model.enabled ? model : undefined;
  }

  private static modelById(
    catalog: RemoteModelCatalog,
    modelId: string
  ): RemoteModelConfig | undefined {
    if (modelId.length === 0) {
      return undefined;
    }
    return catalog.models.find((model: RemoteModelConfig): boolean => model.id === modelId);
  }

  private static capableModels(
    catalog: RemoteModelCatalog,
    capability: string
  ): RemoteModelConfig[] {
    return catalog.models.filter((model: RemoteModelConfig): boolean =>
      model.enabled && (model.capabilities || []).indexOf(capability) >= 0);
  }
}
