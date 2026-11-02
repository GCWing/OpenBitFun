import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { Contrast, LayoutGrid, Moon, Sun } from "lucide-react";
import { Button, Icon, SearchField, Select, TabGroup, type DensityMode } from "@openbitfun/ui";
import {
  themeContractVersion,
  themeTokenCatalog,
  type ThemeDataName,
  type ThemeTokenCatalogEntry,
} from "@openbitfun/theme-openbitfun";
import {
  referenceColorCatalog,
  referenceColorScales,
  type ReferenceColorScaleName,
} from "@openbitfun/theme-openbitfun/authoring";
import { useI18n, type MessageKey } from "../i18n";

type ColorSection = "semantic" | "scale" | "palette" | "mapping";
type SemanticColorGroup =
  | "surface"
  | "content"
  | "action"
  | "accent"
  | "border"
  | "field"
  | "control"
  | "focus"
  | "status";

interface ColorsPageProps {
  density: DensityMode;
  mode: ThemeDataName;
  onDensityChange: (density: DensityMode) => void;
  onModeChange: (mode: ThemeDataName) => void;
}

const semanticColorTokens = themeTokenCatalog.filter(
  (token): token is ThemeTokenCatalogEntry => token.type === "color",
);

const semanticGroupOrder: readonly SemanticColorGroup[] = [
  "surface",
  "content",
  "action",
  "accent",
  "border",
  "field",
  "control",
  "focus",
  "status",
];

const coreSemanticNames = [
  "color.surface.canvas",
  "color.surface.panel",
  "color.surface.subtle",
  "color.surface.raised",
  "color.content.primary",
  "color.content.secondary",
  "color.content.muted",
  "color.content.disabled",
  "color.action.primary.background",
  "color.action.primary.hover",
  "color.action.primary.pressed",
  "color.action.primary.content",
] as const;

const groupLabelKeys: Readonly<Record<SemanticColorGroup, MessageKey>> = {
  accent: "colors.group.accent",
  action: "colors.group.action",
  border: "colors.group.border",
  content: "colors.group.content",
  control: "colors.group.control",
  field: "colors.group.field",
  focus: "colors.group.focus",
  status: "colors.group.status",
  surface: "colors.group.surface",
};

const groupEnglishLabels: Readonly<Record<SemanticColorGroup, string>> = {
  accent: "Accent",
  action: "Action",
  border: "Border",
  content: "Content",
  control: "Control",
  field: "Field",
  focus: "Focus",
  status: "Status",
  surface: "Surface",
};

const coreDescriptionKeys: Readonly<Partial<Record<string, MessageKey>>> = {
  "color.action.primary.background": "colors.description.actionBackground",
  "color.action.primary.content": "colors.description.actionContent",
  "color.action.primary.hover": "colors.description.actionHover",
  "color.action.primary.pressed": "colors.description.actionPressed",
  "color.content.disabled": "colors.description.contentDisabled",
  "color.content.muted": "colors.description.contentMuted",
  "color.content.primary": "colors.description.contentPrimary",
  "color.content.secondary": "colors.description.contentSecondary",
  "color.surface.canvas": "colors.description.surfaceCanvas",
  "color.surface.panel": "colors.description.surfacePanel",
  "color.surface.raised": "colors.description.surfaceRaised",
  "color.surface.subtle": "colors.description.surfaceSubtle",
};

const modeLabelKeys: Readonly<Record<ThemeDataName, MessageKey>> = {
  dark: "colors.mode.dark",
  highContrastDark: "colors.mode.highContrastDark",
  highContrastLight: "colors.mode.highContrastLight",
  light: "colors.mode.light",
};

const sectionTabs: readonly { id: ColorSection; label: MessageKey }[] = [
  { id: "semantic", label: "colors.tab.semantic" },
  { id: "scale", label: "colors.tab.scale" },
  { id: "palette", label: "colors.tab.palette" },
  { id: "mapping", label: "colors.tab.mapping" },
];

const referenceScaleNames = Object.keys(
  referenceColorScales,
) as ReferenceColorScaleName[];

const referenceNameByValue = new Map(
  referenceColorCatalog.map((entry) => [entry.value.toLowerCase(), entry.name]),
);

function getSemanticGroup(token: ThemeTokenCatalogEntry): SemanticColorGroup {
  if (token.name.startsWith("component.button.")) return "action";
  const segment = token.name.split(".")[1] as SemanticColorGroup | undefined;
  return segment && semanticGroupOrder.includes(segment) ? segment : "accent";
}

function formatColorValue(value: string): string {
  return value.startsWith("#") ? value.toUpperCase() : value;
}

function ModeIcon({ mode }: { mode: ThemeDataName }) {
  if (mode === "light") {
    return <Icon glyph={Sun} />;
  }
  if (mode === "dark") {
    return <Icon glyph={Moon} />;
  }
  return <Icon glyph={Contrast} />;
}

function ColorValue({ value }: { value: string }) {
  return (
    <span className="semantic-color-value">
      <i
        aria-hidden="true"
        className="semantic-color-swatch"
        style={{ backgroundColor: value }}
      />
      <code>{formatColorValue(value)}</code>
    </span>
  );
}

export function ColorsPage({
  density,
  mode,
  onDensityChange,
  onModeChange,
}: ColorsPageProps) {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<ColorSection>("semantic");
  const [category, setCategory] = useState<"all" | SemanticColorGroup>("all");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedScale, setSelectedScale] = useState<ReferenceColorScaleName>("blue");

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSemanticTokens = useMemo(() => {
    if (category === "all" && normalizedQuery.length === 0 && !expanded) {
      return coreSemanticNames.flatMap((name) => {
        const token = semanticColorTokens.find((candidate) => candidate.name === name);
        return token ? [token] : [];
      });
    }

    return [...semanticColorTokens]
      .filter((token) => category === "all" || getSemanticGroup(token) === category)
      .filter((token) => {
        if (!normalizedQuery) {
          return true;
        }
        const group = getSemanticGroup(token);
        return [
          token.name,
          token.cssVariable,
          group,
          groupEnglishLabels[group],
          ...Object.values(token.values),
        ].join(" ").toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => {
        const groupDelta = semanticGroupOrder.indexOf(getSemanticGroup(left))
          - semanticGroupOrder.indexOf(getSemanticGroup(right));
        return groupDelta || left.name.localeCompare(right.name);
      });
  }, [category, expanded, normalizedQuery]);

  const groupedSemanticTokens = semanticGroupOrder.flatMap((group) => {
    const tokens = visibleSemanticTokens.filter((token) => getSemanticGroup(token) === group);
    return tokens.length > 0 ? [{ group, tokens }] : [];
  });

  return (
    <main className="lab-page lab-page--colors" id="colors">
      <header className="colors-page-heading">
        <div className="colors-heading-copy">
          <h1>{t("nav.colors")}</h1>
        </div>

        <div className="colors-context-controls">
          <div className="colors-context-control">
            <span>{t("colors.theme")}</span>
            <span className="colors-theme-value">{t("colors.themeName", { version: themeContractVersion })}</span>
          </div>
          <label className="colors-context-control">
            <span>{t("colors.mode")}</span>
            <Select aria-label={t("colors.mode")} leading={<ModeIcon mode={mode} />} value={mode}
              onValueChange={value => onModeChange(value as ThemeDataName)}
              options={Object.entries(modeLabelKeys).map(([value, label]) => ({ value, label: t(label) }))} />
          </label>
          <label className="colors-context-control">
            <span>{t("colors.density")}</span>
            <Select aria-label={t("colors.density")} leading={<Icon glyph={LayoutGrid} />} value={density}
              onValueChange={value => onDensityChange(value as DensityMode)}
              options={(["compact", "comfortable", "touch"] as const).map(value => ({ value, label: t(`settings.${value}`) }))} />
          </label>
        </div>
      </header>

      <TabGroup aria-label={t("colors.tabsLabel")} className="colors-section-navigation"
        value={activeSection} onValueChange={value => setActiveSection(value as ColorSection)}
        items={sectionTabs.map(tab => ({ value: tab.id, label: t(tab.label), id: `colors-tab-${tab.id}`, panelId: `colors-${tab.id}` }))} />

      <section className="colors-doc-card colors-semantic-card" id="colors-semantic" role="tabpanel" aria-labelledby="colors-tab-semantic" hidden={activeSection !== "semantic"} tabIndex={0}>
        <header className="colors-card-heading colors-semantic-heading">
          <h2>{t("colors.semantic.title")}</h2>
          <div className="colors-semantic-tools">
            <SearchField aria-label={t("colors.semantic.searchLabel")} placeholder={t("colors.semantic.searchPlaceholder")}
              value={query} onChange={event => setQuery(event.target.value)} leadingIcon={<Icon name="search" />} />
            <Select aria-label={t("colors.semantic.categoryLabel")} size="sm" value={category}
              onValueChange={value => setCategory(value as "all" | SemanticColorGroup)}
              options={[{ value: "all", label: t("colors.semantic.allCategories") },
                ...semanticGroupOrder.map(group => ({ value: group, label: t(groupLabelKeys[group]) }))]} />
          </div>
        </header>

        <div className="semantic-color-table-scroll">
          <table className="semantic-color-table">
            <colgroup>
              <col className="semantic-color-table__category" />
              <col className="semantic-color-table__token" />
              <col span={4} className="semantic-color-table__mode" />
              <col className="semantic-color-table__description" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t("colors.column.category")}</th>
                <th scope="col">{t("colors.column.token")}</th>
                <th scope="col">{t("colors.mode.light")}</th>
                <th scope="col">{t("colors.mode.dark")}</th>
                <th scope="col">{t("colors.mode.highContrastLight")}</th>
                <th scope="col">{t("colors.mode.highContrastDark")}</th>
                <th scope="col">{t("colors.column.description")}</th>
              </tr>
            </thead>
            <tbody>
              {groupedSemanticTokens.map(({ group, tokens }) => (
                <Fragment key={group}>
                  {tokens.map((token, index) => {
                    const descriptionKey = coreDescriptionKeys[token.name];
                    return (
                      <tr key={token.name}>
                        {index === 0 && (
                          <th rowSpan={tokens.length} scope="rowgroup">
                            <span className={`semantic-color-group semantic-color-group--${group}`}>
                              <i aria-hidden="true" />
                              <strong>{t(groupLabelKeys[group])}</strong>
                              <small>{groupEnglishLabels[group]}</small>
                            </span>
                          </th>
                        )}
                        <th scope="row"><code>{token.name}</code></th>
                        <td><ColorValue value={token.values.light} /></td>
                        <td><ColorValue value={token.values.dark} /></td>
                        <td><ColorValue value={token.values.highContrastLight} /></td>
                        <td><ColorValue value={token.values.highContrastDark} /></td>
                        <td>
                          {descriptionKey
                            ? t(descriptionKey)
                            : t("colors.description.generic", {
                                group: t(groupLabelKeys[group]),
                              })}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
              {groupedSemanticTokens.length === 0 && (
                <tr className="semantic-color-table__empty">
                  <td colSpan={7}>{t("colors.empty")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {category === "all" && normalizedQuery.length === 0 && (
          <div className="colors-expand-action">
            <Button aria-expanded={expanded} onClick={() => setExpanded(current => !current)} variant="text" size="sm"
              trailingIcon={<Icon name={expanded ? "chevron-up" : "chevron-down"} size="sm" />}>
              {expanded ? t("colors.collapse") : t("colors.expand")}
            </Button>
          </div>
        )}
      </section>

      <section className="colors-doc-card colors-scale-card" id="colors-scale" role="tabpanel" aria-labelledby="colors-tab-scale" hidden={activeSection !== "scale"} tabIndex={0}>
        <header className="colors-card-heading">
          <h2>{t("colors.scale.title")}</h2>
          <label className="colors-scale-selector">
            <span>{t("colors.scale.paletteLabel")}</span>
            <Select aria-label={t("colors.scale.paletteLabel")} size="sm" value={selectedScale}
              onValueChange={value => setSelectedScale(value as ReferenceColorScaleName)}
              options={referenceScaleNames.map(scale => ({ value: scale, label: `${scale[0]?.toUpperCase()}${scale.slice(1)}` }))} />
          </label>
        </header>
        <div className="colors-scale-scroll">
          <div className="colors-scale-strip">
            {referenceColorScales[selectedScale].map((entry) => (
              <div className="colors-scale-step" key={entry.name}>
                <strong>{entry.step}</strong>
                <span aria-hidden="true" style={{ backgroundColor: entry.value }} />
                <code>{formatColorValue(entry.value)}</code>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="colors-doc-card colors-palette-card" id="colors-palette" role="tabpanel" aria-labelledby="colors-tab-palette" hidden={activeSection !== "palette"} tabIndex={0}>
        <header className="colors-card-heading colors-card-heading--copy">
          <div>
            <h2>{t("colors.palette.title")}</h2>
            <p>{t("colors.palette.description")}</p>
          </div>
        </header>
        <div className="colors-palette-grid">
          {referenceScaleNames.map((scale) => (
            <article className="colors-palette-row" key={scale}>
              <header>
                <strong>{scale[0]?.toUpperCase()}{scale.slice(1)}</strong>
                <small>{t("tokens.palette.scaleSteps", {
                  count: referenceColorScales[scale].length,
                })}</small>
              </header>
              <div className="colors-palette-swatches">
                {referenceColorScales[scale].map((entry) => (
                  <span
                    aria-label={`${entry.name} · ${entry.value}`}
                    key={entry.name}
                    style={{
                      "--palette-step-color": entry.value,
                    } as CSSProperties}
                    title={`${entry.name} · ${entry.value}`}
                  />
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="colors-doc-card colors-mapping-card" id="colors-mapping" role="tabpanel" aria-labelledby="colors-tab-mapping" hidden={activeSection !== "mapping"} tabIndex={0}>
        <header className="colors-card-heading colors-card-heading--copy">
          <div>
            <h2>{t("colors.mapping.title")}</h2>
            <p>{t("colors.mapping.description")}</p>
          </div>
        </header>
        <div className="colors-mapping-scroll">
          <table className="colors-mapping-table">
            <thead>
              <tr>
                <th>{t("colors.column.token")}</th>
                <th>{t("colors.mapping.reference")}</th>
                <th>{t("colors.mapping.resolved", { mode: t(modeLabelKeys[mode]) })}</th>
              </tr>
            </thead>
            <tbody>
              {semanticColorTokens.map((token) => {
                const value = token.values[mode];
                const referenceName = referenceNameByValue.get(value.toLowerCase());
                return (
                  <tr key={token.name}>
                    <th scope="row"><code>{token.name}</code></th>
                    <td><code>{referenceName ?? t("colors.mapping.unmapped")}</code></td>
                    <td><ColorValue value={value} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
