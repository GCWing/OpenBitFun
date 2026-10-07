import { useState, type ReactNode } from "react";
import { Button, canonicalIconNames, Icon, KeyHint, NumberBadge, SearchField, ThemeRoot, type ColorScheme, type ContrastMode, type DensityMode, type IconName, type TokenOverrides } from "@openbitfun/ui";
import { MobileButton, MobileIconButton, MobileLink } from "@openbitfun/ui/mobile";
import type { ComponentMeta } from "@openbitfun/ui/registry";
import { useI18n } from "../i18n";
import { getOverviewStates, type ComponentPresentation } from "./componentPresentation";
import "./ComponentShowcase.css";

interface ComponentOverviewProps {
  component: ComponentMeta;
  presentation: ComponentPresentation;
  states: readonly string[];
  renderPreview: (state: string) => ReactNode;
  stateLabel: (state: string) => string;
  onInspect: (state: string) => void;
  iconName: IconName;
  onSelectIcon: (name: IconName) => void;
  extraExamples?: ReactNode;
  colorScheme: ColorScheme;
  contrast: ContrastMode;
  density: DensityMode;
  tokenOverrides: TokenOverrides;
}

export function ComponentOverview({ component, presentation, states, renderPreview, stateLabel, onInspect, iconName, onSelectIcon, extraExamples, ...theme }: ComponentOverviewProps) {
  const { t } = useI18n();
  const [iconQuery, setIconQuery] = useState("");
  const compactExamples = component.name === "NumberBadge"
    ? ["0", "8", "128", "99+"].map(value => ({ key: value, content: <NumberBadge value={value} /> }))
    : component.name === "KeyHint"
      ? [
        { key: "Command + K", content: <KeyHint icon={<Icon name="command-mac" />}>K</KeyHint> },
        { key: "Control + Shift + P", content: <KeyHint>Ctrl + Shift + P</KeyHint> },
        { key: "Escape", content: <KeyHint>Esc</KeyHint> },
      ] : component.name === "MobileLink"
        ? (["inline", "surface"] as const).map(appearance => ({ key: stateLabel(appearance), content: <MobileLink appearance={appearance} href="#resources">{t("nav.docs")}</MobileLink> }))
        : null;

  return (
    <ThemeRoot className="design-component-overview" data-presentation={presentation} data-mobile={component.category === "mobile" || undefined} {...theme}>
      {presentation === "icons" ? (
        <>
          <SearchField aria-label={t("preview.searchIcons")} placeholder={t("preview.searchIcons")} value={iconQuery}
            onChange={event => setIconQuery(event.target.value)} onClear={() => setIconQuery("")} clearLabel={t("design.clear")} leadingIcon={<Icon name="search" />} />
          <div className="design-icon-directory">
            {canonicalIconNames.filter(name => name.includes(iconQuery.trim().toLowerCase())).map(name => (
              <button key={name} type="button" aria-pressed={name === iconName} onClick={() => onSelectIcon(name)}>
                <Icon name={name} size="lg" /><span>{name}</span>
              </button>
            ))}
            {!canonicalIconNames.some(name => name.includes(iconQuery.trim().toLowerCase())) && <p>{t("search.noResults", { query: iconQuery })}</p>}
          </div>
        </>
      ) : compactExamples ? (
        <div className="design-example-grid">
          {compactExamples.map(example => <section className="design-component-example" key={example.key}><h3>{example.key}</h3><div className="design-example-content">{example.content}</div></section>)}
        </div>
      ) : (
        <>
          {extraExamples}
          {(component.name === "MobileButton" || component.name === "MobileIconButton") && <section className="design-mobile-appearances">
            <h3>{t("preview.styles")}</h3>
            <div className="design-example-grid">
              {component.name === "MobileButton"
                ? (["primary", "secondary", "plain", "danger"] as const).map(appearance => <div key={appearance}><span>{stateLabel(appearance)}</span><MobileButton appearance={appearance}>{t("components.preview.modalSave")}</MobileButton></div>)
                : (["plain", "surface", "floating"] as const).map(appearance => <div key={appearance}><span>{stateLabel(appearance)}</span><MobileIconButton appearance={appearance} aria-label={t("components.preview.searchLabel")} icon={<Icon name="search" />} /></div>)}
            </div>
            <h3>{t("preview.states")}</h3>
          </section>}
          <div className="design-example-grid">
            {getOverviewStates(component).filter(state => states.includes(state)).map(state => <section className="design-component-example" key={state} data-state={state} data-featured={component.name === "Card" && state === "raised" || undefined}>
              <h3><Button size="xs" variant="text" trailingIcon={<Icon name="arrow-up-right" size="sm" />} onClick={() => onInspect(state)} aria-label={t("preview.inspect", { component: component.name, state: stateLabel(state) })}>
                {stateLabel(state)}
              </Button></h3>
              <div className="design-example-content">{renderPreview(state)}</div>
            </section>)}
          </div>
        </>
      )}
    </ThemeRoot>
  );
}
