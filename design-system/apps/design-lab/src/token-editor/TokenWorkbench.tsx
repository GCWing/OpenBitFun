import { useEffect, useMemo, useState, type ReactNode } from "react";
import { themes } from "@openbitfun/theme-openbitfun";
import { Button, Icon, Input, SearchField, Select, TabGroup, StatusPill } from "@openbitfun/ui";
import { Clipboard, RotateCcw, Save } from "lucide-react";
import { componentRegistry } from "@openbitfun/ui/registry";
import { useI18n, type MessageKey } from "../i18n";
import {
  editableTokenCatalog,
  getCategoryLabel,
  humanizeTokenSegment,
  nonColorTokenCatalog,
  type EditableToken,
  type TokenCollection,
} from "./catalog";
import {
  getActiveTokenMode,
  getTokenDraftKey,
  getTokenValue,
  serializeTokenChanges,
  validateTokenValue,
  type TokenDrafts,
  type TokenEditorContext,
} from "./model";
const SOURCE_ENDPOINT = "/__openbitfun-design-lab/token-source";

type CollectionFilter = "all" | TokenCollection;
type CategoryFilter =
  | "all"
  | "typography"
  | "spacing"
  | "radius"
  | "shadows"
  | "motion"
  | "layers";

const categoryFilters: readonly {
  categories: readonly string[];
  id: CategoryFilter;
}[] = [
  { categories: [], id: "all" },
  { categories: ["type", "font", "lineHeight", "letterSpacing"], id: "typography" },
  { categories: ["space", "control"], id: "spacing" },
  { categories: ["radius", "border", "layout"], id: "radius" },
  { categories: ["shadow"], id: "shadows" },
  { categories: ["motion"], id: "motion" },
  { categories: ["layer", "opacity", "focus"], id: "layers" },
];

const categoryFilterKeys: Readonly<Record<CategoryFilter, MessageKey>> = {
  all: "tokens.filter.all",
  layers: "tokens.filter.layers",
  motion: "tokens.filter.motion",
  radius: "tokens.filter.radius",
  shadows: "tokens.filter.shadows",
  spacing: "tokens.filter.spacing",
  typography: "tokens.filter.typography",
};

const tokenCategoryKeys: Readonly<Record<string, MessageKey>> = {
  type: "tokens.category.font",
  letterSpacing: "tokens.category.font",
  border: "tokens.category.border",
  color: "tokens.category.color",
  control: "tokens.category.control",
  focus: "tokens.category.focus",
  font: "tokens.category.font",
  layer: "tokens.category.layer",
  layout: "tokens.category.layout",
  lineHeight: "tokens.category.lineHeight",
  motion: "tokens.category.motion",
  opacity: "tokens.category.opacity",
  radius: "tokens.category.radius",
  shadow: "tokens.category.shadow",
  space: "tokens.category.space",
};

const validationMessageKeys: Readonly<Record<string, MessageKey>> = {
  "Use a finite number.": "tokens.validation.number",
  "Use a number with px, rem, em, or %.": "tokens.validation.dimension",
  "Use a positive duration in ms or s.": "tokens.validation.duration",
  "Use a six-digit hexadecimal color.": "tokens.validation.color",
  "Use an integer from 1 to 1000.": "tokens.validation.fontWeight",
  "Use cubic-bezier(x1, y1, x2, y2).": "tokens.validation.cubicBezier",
  "Value is required.": "tokens.validation.required",
  "Value is too long.": "tokens.validation.tooLong",
};

type OperationState =
  | { kind: "idle" }
  | { kind: "writing" }
  | { count: number; kind: "saved" }
  | { kind: "exported" }
  | { kind: "error"; message?: string };

export interface TokenWorkbenchProps {
  componentScope: string;
  context: TokenEditorContext;
  drafts: TokenDrafts;
  onComponentScopeChange: (scope: string) => void;
  onResetAll: () => void;
  onResetToken: (token: EditableToken) => void;
  onTokenChange: (token: EditableToken, value: string) => void;
  preview: ReactNode;
}

function tokenIdentity(token: EditableToken): string {
  return `${token.collection}:${token.name}`;
}

function getTokenOwners(tokenName: string): string[] {
  return componentRegistry
    .filter((component) =>
      (component.tokens as readonly string[]).includes(tokenName),
    )
    .map((component) => component.name);
}

function TokenValueControl({
  error,
  onChange,
  token,
  value,
}: {
  error?: string;
  onChange: (value: string) => void;
  token: EditableToken;
  value: string;
}) {
  const { t } = useI18n();
  const inputType = token.type === "number" || token.type === "fontWeight"
    ? "number"
    : "text";

  return (
    <div className="token-value-control">
      {token.type === "color" && (
        <input
          aria-label={t("tokens.colorPicker", { name: token.name })}
          className="token-color-picker"
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value)
            ? value
            : String(themes.light["color.content.onLight"])}
        />
      )}
      <Input
        invalid={Boolean(error)}
        aria-label={t("tokens.valueInput", { name: token.name })}
        onChange={(event) => onChange(event.target.value)}
        step={token.type === "number" ? "0.01" : undefined}
        type={inputType}
        value={value}
      />
      {error && <span className="token-error">{error}</span>}
    </div>
  );
}

export function TokenWorkbench({
  componentScope,
  context,
  drafts,
  onComponentScopeChange,
  onResetAll,
  onResetToken,
  onTokenChange,
  preview,
}: TokenWorkbenchProps) {
  const { locale, t } = useI18n();
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [collection, setCollection] = useState<CollectionFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const [sourceWritable, setSourceWritable] = useState(false);
  const [sourceChecked, setSourceChecked] = useState(false);
  const [operationState, setOperationState] = useState<OperationState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    let active = true;
    fetch(SOURCE_ENDPOINT, { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((result: { writable?: boolean }) => {
        if (active) {
          setSourceWritable(result.writable === true);
          setSourceChecked(true);
        }
      })
      .catch(() => {
        if (active) {
          setSourceWritable(false);
          setSourceChecked(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedComponent = componentScope === "all"
    ? undefined
    : componentRegistry.find((component) => component.name === componentScope);
  const normalizedQuery = query.trim().toLowerCase();
  const activeCategory = categoryFilters.find((filter) => filter.id === category);
  const visibleTokens = useMemo(
    () => nonColorTokenCatalog.filter((token) => {
      if (collection !== "all" && token.collection !== collection) {
        return false;
      }
      if (
        activeCategory &&
        activeCategory.categories.length > 0 &&
        !activeCategory.categories.includes(token.category)
      ) {
        return false;
      }
      if (
        selectedComponent &&
        !(selectedComponent.tokens as readonly string[]).includes(token.name)
      ) {
        return false;
      }
      if (normalizedQuery.length > 0) {
        const categoryKey = tokenCategoryKeys[token.category];
        const localizedCategory = categoryKey ? t(categoryKey) : getCategoryLabel(token.category);
        const searchable = `${token.name} ${token.cssVariable} ${token.type} ${token.category} ${localizedCategory}`.toLowerCase();
        if (!searchable.includes(normalizedQuery)) {
          return false;
        }
      }
      return true;
    }),
    [activeCategory, collection, normalizedQuery, selectedComponent, t],
  );

  const selectedToken = visibleTokens.find(
    (token) => tokenIdentity(token) === selectedTokenId,
  ) ?? visibleTokens[0];

  useEffect(() => {
    if (selectedToken && tokenIdentity(selectedToken) !== selectedTokenId) {
      setSelectedTokenId(tokenIdentity(selectedToken));
    }
  }, [selectedToken, selectedTokenId]);

  const changes = serializeTokenChanges(drafts);
  const invalidChanges = changes.filter((change) => {
    const token = editableTokenCatalog.find((candidate) =>
      candidate.collection === change.collection && candidate.name === change.name,
    );
    return token ? Boolean(validateTokenValue(token.type, change.value)) : true;
  });

  async function saveToSource() {
    if (!sourceWritable || changes.length === 0 || invalidChanges.length > 0) {
      return;
    }
    setSaving(true);
    setOperationState({ kind: "writing" });
    try {
      const response = await fetch(SOURCE_ENDPOINT, {
        body: JSON.stringify({ changes }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      const result = await response.json() as { error?: string; saved?: number };
      if (!response.ok) {
        throw new Error(result.error);
      }
      setOperationState({ count: result.saved ?? changes.length, kind: "saved" });
      onResetAll();
      window.setTimeout(() => window.location.reload(), 120);
    } catch (error) {
      setOperationState({
        kind: "error",
        message: error instanceof Error && error.message ? error.message : undefined,
      });
      setSaving(false);
    }
  }

  function exportDraft() {
    const payload = JSON.stringify(
      { changes, contract: "@openbitfun/token-draft@1" },
      null,
      2,
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = "openbitfun-token-draft.json";
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    setOperationState({ kind: "exported" });
  }

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(label);
      window.setTimeout(() => setCopyStatus(""), 1400);
    } catch {
      setCopyStatus("unavailable");
    }
  }

  const selectedMode = selectedToken
    ? getActiveTokenMode(selectedToken, context)
    : undefined;
  const selectedKey = selectedToken && selectedMode
    ? getTokenDraftKey(selectedToken.collection, selectedMode, selectedToken.name)
    : undefined;
  const selectedValue = selectedToken
    ? getTokenValue(selectedToken, context, drafts)
    : "";
  const selectedEdited = selectedKey ? drafts[selectedKey] !== undefined : false;
  const selectedRawError = selectedToken && selectedEdited
    ? validateTokenValue(selectedToken.type, selectedValue)
    : undefined;
  const selectedErrorKey = selectedRawError ? validationMessageKeys[selectedRawError] : undefined;
  const selectedError = selectedErrorKey ? t(selectedErrorKey) : selectedRawError;
  const selectedOwners = selectedToken ? getTokenOwners(selectedToken.name) : [];
  const getLocalizedCategoryLabel = (tokenCategory: string) => {
    const key = tokenCategoryKeys[tokenCategory];
    return key ? t(key) : getCategoryLabel(tokenCategory);
  };
  const getCollectionLabel = (tokenCollection: TokenCollection) =>
    tokenCollection === "system"
      ? t("tokens.collection.system")
      : t("tokens.collection.theme");
  const operationMessage = operationState.kind === "writing"
    ? t("tokens.status.writing")
    : operationState.kind === "saved"
      ? t("tokens.status.saved", { count: operationState.count })
      : operationState.kind === "exported"
        ? t("tokens.status.exported")
        : operationState.kind === "error"
          ? operationState.message ?? t("tokens.status.failed")
          : "";

  return (
    <main className="lab-page lab-page--tokens" id="tokens">
      <header className="page-heading page-heading--split token-page-heading">
        <div>
          <h1>{t("tokens.title")}</h1>
        </div>
        <div className="token-page-actions">
          <div className="token-source-status" role="status">
            <span data-ready={sourceWritable || undefined} />
            <span>
              {operationMessage || (sourceChecked
                ? sourceWritable
                  ? t("tokens.status.ready")
                  : t("tokens.status.draft")
                : t("tokens.status.checking"))}
            </span>
          </div>
          {invalidChanges.length > 0 && (
            <span className="token-save-error">
              {t("tokens.invalidEdits", { count: invalidChanges.length })}
            </span>
          )}
          <div className="token-action-row">
            <span className="token-edit-count">{t("tokens.editCount", { count: changes.length })}</span>
            <Button size="sm" disabled={changes.length === 0} onClick={onResetAll} leadingIcon={<Icon glyph={RotateCcw} size="sm" />}>
              {t("tokens.reset")}
            </Button>
            <Button size="sm" disabled={changes.length === 0} onClick={exportDraft} leadingIcon={<Icon name="arrow-down" size="sm" />}>
              {t("tokens.export")}
            </Button>
            <Button size="sm" variant="primary" loading={saving}
              disabled={!sourceWritable || changes.length === 0 || invalidChanges.length > 0}
              onClick={saveToSource} leadingIcon={<Icon glyph={Save} size="sm" />}>
              {saving ? t("tokens.saving") : t("tokens.saveSource")}
            </Button>
          </div>
        </div>
      </header>

      <TabGroup className="token-category-navigation" aria-label={t("tokens.categoriesLabel")}
        value={category} onValueChange={value => setCategory(value as CategoryFilter)}
        items={categoryFilters.map(filter => ({ value: filter.id, label: t(categoryFilterKeys[filter.id]) }))} />

      <section className="token-workspace" aria-label={t("tokens.catalogLabel")}>
        <div className="token-catalog-panel">
          <div className="token-tools">
            <SearchField aria-label={t("tokens.searchLabel")} placeholder={t("tokens.searchPlaceholder")}
              onChange={event => setQuery(event.target.value)} value={query} leadingIcon={<Icon name="search" />} />
            <Select aria-label={t("tokens.collectionFilter")} size="sm" value={collection}
              onValueChange={value => setCollection(value as CollectionFilter)}
              options={(["all", "system", "theme"] as const).map(value => ({ value, label: t(`tokens.collection.${value}`) }))} />
            <Select aria-label={t("tokens.componentFilter")} size="sm" value={componentScope}
              onValueChange={value => onComponentScopeChange(String(value))}
              options={[{ value: "all", label: t("tokens.components.all") }, ...componentRegistry.map(component => ({ value: component.name, label: component.name }))]} />
          </div>

          <div className="token-table">
            <div className="token-table__header">
              <span>{t("tokens.column.token")}</span>
              <span>{t("tokens.column.value")}</span>
              <span>{t("tokens.column.category")}</span>
            </div>
            <div className="token-table__body" role="listbox" aria-label={t("tokens.listLabel")}>
              {visibleTokens.map((token) => {
                const mode = getActiveTokenMode(token, context);
                const key = getTokenDraftKey(token.collection, mode, token.name);
                const value = getTokenValue(token, context, drafts);
                const active = selectedToken ? tokenIdentity(selectedToken) === tokenIdentity(token) : false;
                return (
                  <button
                    aria-selected={active}
                    className="token-table__row"
                    data-active={active || undefined}
                    data-edited={drafts[key] !== undefined || undefined}
                    key={tokenIdentity(token)}
                    onClick={() => setSelectedTokenId(tokenIdentity(token))}
                    role="option"
                    type="button"
                  >
                    <span>
                      <strong>{humanizeTokenSegment(token.name.split(".").at(-1) ?? token.name)}</strong>
                      <code>{token.name}</code>
                    </span>
                    <span>
                      {token.type === "color" && (
                        <i aria-hidden="true" className="token-value-swatch" style={{ backgroundColor: value }} />
                      )}
                      <code>{value}</code>
                    </span>
                    <span>
                      {getLocalizedCategoryLabel(token.category)}
                      {drafts[key] !== undefined && <i>{t("tokens.edited")}</i>}
                    </span>
                  </button>
                );
              })}
              {visibleTokens.length === 0 && (
                <div className="token-empty">{t("tokens.empty")}</div>
              )}
            </div>
            <div className="token-table__footer">
              <span>{t("tokens.showing", {
                total: nonColorTokenCatalog.length,
                visible: visibleTokens.length,
              })}</span>
              <span>{context.density} · {context.theme}</span>
            </div>
          </div>
        </div>

        <aside className="token-inspector" aria-label={t("tokens.inspectorLabel")}>
          {selectedToken && selectedMode ? (
            <>
              <div className="token-inspector__heading">
                <div>
                  <span className="page-kicker">
                    {t("tokens.inspector.collectionToken", {
                      collection: getCollectionLabel(selectedToken.collection),
                    })}
                  </span>
                  <h2>{selectedToken.name}</h2>
                </div>
                {selectedEdited && (
                  <StatusPill>{t("tokens.edited")}</StatusPill>
                )}
              </div>

              <div className="token-inspector__section">
                <div className="token-inspector__label-row">
                  <strong>{t("tokens.inspector.value")}</strong>
                  <span>{selectedMode}</span>
                </div>
                <TokenValueControl
                  error={selectedError}
                  onChange={(value) => onTokenChange(selectedToken, value)}
                  token={selectedToken}
                  value={selectedValue}
                />
                {selectedEdited && (
                  <Button variant="text" size="sm" onClick={() => onResetToken(selectedToken)}>
                    {t("tokens.inspector.resetToken")}
                  </Button>
                )}
              </div>

              <div className="token-inspector__section">
                <strong>{t("tokens.inspector.cssVariable")}</strong>
                <button
                  aria-label={t("tokens.inspector.copyCssVariable")}
                  className="copy-value-row"
                  onClick={() => copyValue("variable", selectedToken.cssVariable)}
                  type="button"
                >
                  <code>{selectedToken.cssVariable}</code>
                  {copyStatus === "variable"
                    ? <Icon name="check-line" size="lg" aria-hidden="true" style={{ width: 15, height: 15 }} />
                    : <Icon glyph={Clipboard} size="sm" />}
                </button>
              </div>

              <div className="token-inspector__section">
                <strong>{t("tokens.inspector.description")}</strong>
                <p>
                  {locale === "en-US" && selectedToken.description
                    ? selectedToken.description
                    : t("tokens.inspector.genericDescription", {
                        category: getLocalizedCategoryLabel(selectedToken.category),
                        collection: getCollectionLabel(selectedToken.collection),
                      })}
                </p>
              </div>

              <div className="token-inspector__section">
                <strong>{t("tokens.inspector.references")}</strong>
                {selectedOwners.length > 0 ? (
                  <div className="token-owner-list">
                    {selectedOwners.map((owner) => <span key={owner}>{owner}</span>)}
                  </div>
                ) : (
                  <p>{t("tokens.inspector.sharedFoundation")}</p>
                )}
              </div>

              <div className="token-inspector__section token-inspector__meta">
                <span><strong>{t("tokens.inspector.type")}</strong>{selectedToken.type}</span>
                <span><strong>{t("tokens.inspector.category")}</strong>{getLocalizedCategoryLabel(selectedToken.category)}</span>
                <span><strong>{t("tokens.inspector.mode")}</strong>{selectedMode}</span>
              </div>
            </>
          ) : (
            <div className="token-inspector__empty">{t("tokens.inspector.empty")}</div>
          )}
        </aside>
      </section>

      <section className="token-system-preview" aria-label={t("tokens.previewLabel")}>
        {preview}
      </section>
    </main>
  );
}
