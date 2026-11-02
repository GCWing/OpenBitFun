import {
  ConversationUiModel,
  ConversationUiModelCatalog
} from '../state/ConversationUiModels';

/** One role row of the composer selector's defaults section. */
export interface ConversationUiModelRoleEntry {
  /** Semantic model id sent to the host: `primary` or `fast`. */
  role: string;
  labelKey: string;
  /** Concrete model the role runs, or undefined when it has no target. */
  model: ConversationUiModel | undefined;
  /** True when the role runs the primary model because it has none of its own. */
  fallsBackToPrimary: boolean;
}

export class ConversationModelPresentationPolicy {
  /** Semantic selectors the host accepts in place of a concrete model id. */
  static readonly ROLE_PRIMARY: string = 'primary';
  static readonly ROLE_FAST: string = 'fast';

  static enabledModels(catalog: ConversationUiModelCatalog): ConversationUiModel[] {
    return catalog.models.filter((model: ConversationUiModel) => model.enabled);
  }

  /**
   * Resolves a selector to an enabled concrete model.
   *
   * `primary` resolves the configured primary model; `fast` uses its own model
   * and falls back to the primary model when none is configured, exactly like
   * the host's own model selection. Empty, `auto`, `default` and unknown
   * selectors resolve to nothing so callers keep their existing fallback chain.
   */
  static resolveModel(
    catalog: ConversationUiModelCatalog,
    modelId: string
  ): ConversationUiModel | undefined {
    const value = (modelId || '').trim();
    if (value.length === 0) {
      return undefined;
    }
    if (value === ConversationModelPresentationPolicy.ROLE_PRIMARY) {
      return ConversationModelPresentationPolicy.enabledModel(catalog, catalog.default_models.primary || '');
    }
    if (value === ConversationModelPresentationPolicy.ROLE_FAST) {
      return ConversationModelPresentationPolicy.enabledModel(catalog, catalog.default_models.fast || '') ||
        ConversationModelPresentationPolicy.enabledModel(catalog, catalog.default_models.primary || '');
    }
    return ConversationModelPresentationPolicy.enabledModel(catalog, value);
  }

  static isSemanticModelId(modelId: string): boolean {
    const value = (modelId || '').trim();
    return value === ConversationModelPresentationPolicy.ROLE_PRIMARY ||
      value === ConversationModelPresentationPolicy.ROLE_FAST;
  }

  /** The selected role, or an empty string when the selection is not a role. */
  static selectedRole(selectedModelId: string): string {
    const value = (selectedModelId || '').trim();
    return ConversationModelPresentationPolicy.isSemanticModelId(value) ? value : '';
  }

  /**
   * The selected role only while it still resolves to an enabled concrete
   * model. A role the catalog can no longer run is presented as no selection at
   * all, so the trigger and the role rows agree.
   */
  static resolvedSelectedRole(catalog: ConversationUiModelCatalog, selectedModelId: string): string {
    const role = ConversationModelPresentationPolicy.selectedRole(selectedModelId);
    if (role.length === 0) {
      return '';
    }
    return ConversationModelPresentationPolicy.resolveModel(catalog, role) ? role : '';
  }

  static roleLabelKey(role: string): string {
    if (role === ConversationModelPresentationPolicy.ROLE_PRIMARY) {
      return 'chat.modelPrimary';
    }
    if (role === ConversationModelPresentationPolicy.ROLE_FAST) {
      return 'chat.modelFast';
    }
    return '';
  }

  static roleBadgeLabelKey(role: string): string {
    if (role === ConversationModelPresentationPolicy.ROLE_PRIMARY) {
      return 'chat.modelRolePrimary';
    }
    if (role === ConversationModelPresentationPolicy.ROLE_FAST) {
      return 'chat.modelRoleFast';
    }
    return '';
  }

  /** Roles a concrete model id serves, in primary-then-fast order. */
  static modelRoles(catalog: ConversationUiModelCatalog, modelId: string): string[] {
    const value = (modelId || '').trim();
    const roles: string[] = [];
    if (value.length === 0) {
      return roles;
    }
    if (value === (catalog.default_models.primary || '').trim()) {
      roles.push(ConversationModelPresentationPolicy.ROLE_PRIMARY);
    }
    if (value === (catalog.default_models.fast || '').trim()) {
      roles.push(ConversationModelPresentationPolicy.ROLE_FAST);
    }
    return roles;
  }

  /**
   * Defaults section rows. Empty when neither role resolves to an enabled
   * model, so the selector stays a plain model list.
   */
  static roleEntries(catalog: ConversationUiModelCatalog): ConversationUiModelRoleEntry[] {
    const primary = ConversationModelPresentationPolicy.resolveModel(
      catalog, ConversationModelPresentationPolicy.ROLE_PRIMARY);
    const fast = ConversationModelPresentationPolicy.resolveModel(
      catalog, ConversationModelPresentationPolicy.ROLE_FAST);
    if (!primary && !fast) {
      return [];
    }
    const ownFast = ConversationModelPresentationPolicy.enabledModel(catalog, catalog.default_models.fast || '');
    return [
      {
        role: ConversationModelPresentationPolicy.ROLE_PRIMARY,
        labelKey: ConversationModelPresentationPolicy.roleLabelKey(ConversationModelPresentationPolicy.ROLE_PRIMARY),
        model: primary,
        fallsBackToPrimary: false
      },
      {
        role: ConversationModelPresentationPolicy.ROLE_FAST,
        labelKey: ConversationModelPresentationPolicy.roleLabelKey(ConversationModelPresentationPolicy.ROLE_FAST),
        model: fast,
        fallsBackToPrimary: !ownFast
      }
    ];
  }

  /**
   * Trigger label key for a role selection, or an empty string when the
   * selection names a concrete model or the role no longer resolves.
   */
  static selectedModelLabelKey(catalog: ConversationUiModelCatalog, selectedModelId: string): string {
    return ConversationModelPresentationPolicy.roleLabelKey(
      ConversationModelPresentationPolicy.resolvedSelectedRole(catalog, selectedModelId));
  }

  /**
   * Notice key that replaces a role row's resolved-model metadata, or an empty
   * string when the row shows the resolved model instead.
   */
  static roleMetaNoticeKey(entry: ConversationUiModelRoleEntry): string {
    return entry.fallsBackToPrimary ? 'chat.modelFastNotConfigured' : '';
  }

  /**
   * True when a concrete row owns the current selection. A role selection
   * highlights its role row instead, so no concrete row is marked.
   */
  static isConcreteModelSelected(selectedModelId: string, modelId: string): boolean {
    const value = (selectedModelId || '').trim();
    return value.length > 0 &&
      !ConversationModelPresentationPolicy.isSemanticModelId(value) &&
      value === (modelId || '').trim();
  }

  static selectedModel(
    catalog: ConversationUiModelCatalog,
    selectedModelId: string
  ): ConversationUiModel | undefined {
    const candidates = [
      selectedModelId,
      catalog.session_model_id || '',
      catalog.default_models.primary || ''
    ];
    for (let index = 0; index < candidates.length; index += 1) {
      const model = ConversationModelPresentationPolicy.resolveModel(catalog, candidates[index]);
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  static primaryLabel(model: ConversationUiModel, fallback: string): string {
    const modelName = ConversationModelPresentationPolicy.cleanLabel(model.model_name || '');
    if (ConversationModelPresentationPolicy.isSpecificLabel(modelName)) {
      return modelName;
    }
    const name = ConversationModelPresentationPolicy.cleanLabel(model.name || '');
    if (ConversationModelPresentationPolicy.isSpecificLabel(name)) {
      return name;
    }
    const id = ConversationModelPresentationPolicy.cleanLabel(model.id || '');
    return id.length > 0 ? id : fallback;
  }

  static secondaryLabel(model: ConversationUiModel, fallback: string): string {
    const provider = ConversationModelPresentationPolicy.cleanLabel(model.provider || '');
    const name = ConversationModelPresentationPolicy.cleanLabel(model.name || '');
    const primary = ConversationModelPresentationPolicy.primaryLabel(model, fallback);
    if (provider.length > 0 && name.length > 0 && name !== primary && name !== provider) {
      return `${provider} · ${name}`;
    }
    if (provider.length > 0 && provider !== primary) {
      return provider;
    }
    if (name.length > 0 && name !== primary) {
      return name;
    }
    return model.id || primary;
  }

  /** Provider and context-window metadata, e.g. `openai · 128k`. */
  static modelContextLabel(model: ConversationUiModel): string {
    const parts: string[] = [];
    const provider = ConversationModelPresentationPolicy.cleanLabel(model.provider || '');
    if (provider.length > 0) {
      parts.push(provider);
    }
    const context = ConversationModelPresentationPolicy.contextWindowLabel(model.context_window);
    if (context.length > 0) {
      parts.push(context);
    }
    return parts.join(' · ');
  }

  /** Resolved model name plus its provider/context metadata for a role row. */
  static roleMetaLabel(model: ConversationUiModel | undefined, fallback: string): string {
    if (!model) {
      return '';
    }
    const name = ConversationModelPresentationPolicy.primaryLabel(model, fallback);
    const context = ConversationModelPresentationPolicy.modelContextLabel(model);
    return context.length > 0 ? `${name} · ${context}` : name;
  }

  private static enabledModel(
    catalog: ConversationUiModelCatalog,
    modelId: string
  ): ConversationUiModel | undefined {
    const value = (modelId || '').trim();
    if (value.length === 0) {
      return undefined;
    }
    return catalog.models.find((item: ConversationUiModel) => item.id === value && item.enabled);
  }

  private static contextWindowLabel(contextWindow: number | undefined): string {
    if (!contextWindow || contextWindow <= 0) {
      return '';
    }
    return `${Math.round(contextWindow / 1000)}k`;
  }

  private static cleanLabel(value: string): string {
    const trimmed = (value || '').trim();
    if (trimmed.length === 0) {
      return '';
    }
    const withoutScheme = trimmed.replace(/^openbitfun[:/_-]+/i, '').replace(/^anthropic[:/_-]+/i, '');
    const parts = withoutScheme.split(/[/:]/).filter((part: string) => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : withoutScheme;
  }

  private static isSpecificLabel(label: string): boolean {
    const normalized = label.toLowerCase();
    return label.length > 0 &&
      normalized !== 'openbitfun' &&
      normalized !== 'anthropic' &&
      normalized !== 'openai' &&
      normalized !== 'google' &&
      normalized !== 'azure' &&
      normalized !== 'openbitfun';
  }
}
