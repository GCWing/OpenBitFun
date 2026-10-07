import { useState, type CSSProperties } from "react";
import { Layers } from "lucide-react";
import { Icon, Switch, TabGroup } from "@openbitfun/ui";
import { useI18n } from "../i18n";
import { nonColorTokenCatalog } from "../token-editor/catalog";
import { CopyValue, TokenCopy, cssToken, foundationTypeStyle } from "./FoundationTokens";
import "./FoundationSpecimens.css";

type TokenValueReader = (name: string) => string;
const spacingTokens = nonColorTokenCatalog.filter(token => /^space\.\d+$/.test(token.name))
  .sort((a, b) => Number(a.name.split(".")[1]) - Number(b.name.split(".")[1]));
const spaceViews = ["inline", "stack", "inset"] as const;
type SpaceView = typeof spaceViews[number];
const surfaceRoles = ["canvas", "panel", "subtle", "raised"] as const;
const radiusRoles = ["sm", "md", "lg", "xl", "pill"] as const;

export function SpacingExplorer({ tokenValue }: { tokenValue: TokenValueReader }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState("space.4");
  const [view, setView] = useState<SpaceView>("inline");
  const [guides, setGuides] = useState(true);
  const value = tokenValue(selected);
  const spaceStyle = { "--_specimen-space": cssToken(selected) } as CSSProperties;
  const declaration = view === "inset"
    ? `padding: ${cssToken(selected)};`
    : `display: flex;\n${view === "stack" ? "flex-direction: column;\n" : ""}gap: ${cssToken(selected)};`;

  return (
    <div className="foundation-spacing-explorer">
      <div className="foundation-specimen-toolbar">
        <TabGroup
          aria-label={t("foundations.space.arrangement")}
          size="sm"
          value={view}
          onValueChange={next => setView(next as SpaceView)}
          items={spaceViews.map(item => ({
            id: `foundation-space-tab-${item}`,
            panelId: "foundation-space-panel",
            value: item,
            label: t(`foundations.space.${item}`),
          }))}
        />
        <label className="foundation-measure-toggle" htmlFor="foundation-space-guides">
          <Switch id="foundation-space-guides" checked={guides} onCheckedChange={setGuides} />
          <span>{t("foundations.space.guides")}</span>
        </label>
      </div>

      <div className="foundation-space-workbench" role="tabpanel" id="foundation-space-panel" aria-labelledby={`foundation-space-tab-${view}`} tabIndex={0}>
        <figure className="foundation-space-figure" style={spaceStyle} data-guides={guides}>
          <div className="foundation-space-drawing" role="img" aria-label={t(`foundations.space.${view}Description`, { value })}>
            {view === "inset" ? (
              <div className="foundation-inset-object">
                <span className="foundation-inset-content">{t("foundations.space.content")}</span>
                <span className="foundation-inset-measure" aria-hidden="true"><span>{value}</span></span>
              </div>
            ) : (
              <div className="foundation-space-pair" data-axis={view}>
                <span className="foundation-space-object">A</span>
                <span className="foundation-space-dimension" aria-hidden="true"><span>{value}</span></span>
                <span className="foundation-space-object">B</span>
              </div>
            )}
          </div>
          <figcaption>{t(`foundations.space.${view}Description`, { value })}</figcaption>
        </figure>
        <div className="foundation-space-reading">
          <span className="foundation-specimen-eyebrow">{t("design.actualSize")}</span>
          <strong>{value}</strong>
          <TokenCopy name={selected} />
          <p>{t("foundations.space.selectHint")}</p>
          <CopyValue value={declaration} label={t("foundations.copyCSS")} className="foundation-declaration-copy">
            <span>{t("foundations.copyCSS")}</span>
          </CopyValue>
          <pre><code>{declaration}</code></pre>
        </div>
      </div>

      <fieldset className="foundation-space-scale">
        <legend>{t("foundations.spacingScale")}</legend>
        <div>
          {spacingTokens.map(token => (
            <label className="foundation-scale-step" key={token.name} style={{ "--_specimen-space": cssToken(token.name) } as CSSProperties}>
              <input className="foundation-sr-only" type="radio" name="foundation-space-scale" value={token.name}
                checked={selected === token.name} onChange={() => setSelected(token.name)}
                aria-label={`${token.name}, ${tokenValue(token.name)}`} />
              <span className="foundation-scale-step-body">
                <span className="foundation-scale-distance" aria-hidden="true"><i /><i /></span>
                <code>{tokenValue(token.name)}</code>
                <span>{token.name}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function ColorRelationships({ tokenValue }: { tokenValue: TokenValueReader }) {
  const { t } = useI18n();
  const [surface, setSurface] = useState<typeof surfaceRoles[number]>("panel");
  const name = `color.surface.${surface}`;
  return (
    <div className="foundation-color-relationships">
      <div className="foundation-color-composition" style={{ background: cssToken(name) }}>
        <div className="foundation-color-copy">
          <h3 style={{ color: cssToken("color.content.primary") }}>{t("design.foundations")}</h3>
          <p style={{ color: cssToken("color.content.secondary") }}>{t("design.foundationsIntro")}</p>
          <span style={{ color: cssToken("color.content.muted") }}>{t("foundations.color.supporting")}</span>
        </div>
        <div className="foundation-color-role-legend">
          {["primary", "secondary", "muted"].map(role => (
            <div key={role}>
              <i aria-hidden="true" style={{ background: cssToken(`color.content.${role}`) }} />
              <TokenCopy name={`color.content.${role}`} />
              <code>{tokenValue(`color.content.${role}`)}</code>
            </div>
          ))}
        </div>
      </div>
      <fieldset className="foundation-surface-picker">
        <legend>{t("foundations.color.background")}</legend>
        <div>
          {surfaceRoles.map(role => (
            <label key={role}>
              <input type="radio" className="foundation-sr-only" name="foundation-surface" value={role}
                checked={surface === role} onChange={() => setSurface(role)} aria-label={`surface.${role}`} />
              <span className="foundation-surface-option">
                <i style={{ background: cssToken(`color.surface.${role}`) }} aria-hidden="true" />
                <code>surface.{role}</code>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="foundation-specimen-footnote">
        <p>{t("foundations.color.hint")}</p>
        <span><TokenCopy name={name} /><code>{tokenValue(name)}</code></span>
      </div>
    </div>
  );
}

export function TypographyComposition() {
  const { t } = useI18n();
  return (
    <div className="foundation-reading-specimen" aria-label={t("foundations.type.composition")}>
      <div className="foundation-reading-line" data-type="heading.page">
        <h3 style={foundationTypeStyle("heading.page")}>{t("design.foundations")}</h3>
        <code>heading.page</code>
      </div>
      <div className="foundation-reading-line" data-type="body.lg">
        <p style={foundationTypeStyle("body.lg")}>{t("design.foundationsIntro")}</p>
        <code>body.lg</code>
      </div>
      <div className="foundation-reading-line" data-type="heading.section">
        <h4 style={foundationTypeStyle("heading.section")}>{t("design.space")}</h4>
        <code>heading.section</code>
      </div>
      <div className="foundation-reading-line" data-type="body.md">
        <p style={foundationTypeStyle("body.md")}>{t("design.spaceNote")}</p>
        <code>body.md</code>
      </div>
      <div className="foundation-reading-line" data-type="label.md">
        <span style={foundationTypeStyle("label.md")}>{t("foundations.spacingScale")}</span>
        <code>label.md</code>
      </div>
      <div className="foundation-reading-line" data-type="code.sm">
        <pre style={foundationTypeStyle("code.sm")}>gap: {cssToken("space.4")};</pre>
        <code>code.sm</code>
      </div>
    </div>
  );
}

export function ShapeExplorer({ tokenValue }: { tokenValue: TokenValueReader }) {
  const { t } = useI18n();
  const [radius, setRadius] = useState<typeof radiusRoles[number]>("md");
  const name = `radius.${radius}`;
  return (
    <div className="foundation-shape-explorer">
      <h3 className="foundation-subheading">{t("foundations.corners")}</h3>
      <div className="foundation-radius-workbench">
        <figure className="foundation-radius-figure">
          <div className="foundation-radius-object" style={{ "--_specimen-radius": cssToken(name) } as CSSProperties}>
            <span className="foundation-radius-guide" aria-hidden="true" />
            <span className="foundation-radius-crosshair" aria-hidden="true" />
            <span className="foundation-radius-caption"><strong>{tokenValue(name)}</strong><code>{name}</code></span>
          </div>
          <figcaption>{t(radius === "pill" ? "foundations.shape.pillHint" : "foundations.shape.cornerHint")}</figcaption>
        </figure>
        <fieldset className="foundation-radius-picker">
          <legend>{t("foundations.shape.compare")}</legend>
          {radiusRoles.map(role => (
            <label key={role}>
              <input type="radio" className="foundation-sr-only" name="foundation-radius" value={role}
                checked={radius === role} onChange={() => setRadius(role)} aria-label={`radius.${role}, ${tokenValue(`radius.${role}`)}`} />
              <span>
                <i style={{ borderRadius: cssToken(`radius.${role}`) }} aria-hidden="true" />
                <code>radius.{role}</code>
                <code>{tokenValue(`radius.${role}`)}</code>
              </span>
            </label>
          ))}
          <TokenCopy name={name} />
        </fieldset>
      </div>

      <h3 className="foundation-subheading">{t("foundations.elevation")}</h3>
      <div className="foundation-elevation-plane">
        {["xs", "sm", "lg"].map(shadow => (
          <figure key={shadow} className="foundation-elevation-layer">
            <div className="foundation-elevation-lower">
              <span className="foundation-elevation-upper" style={{ boxShadow: cssToken(`shadow.${shadow}`) }}>
                <Icon glyph={Layers} size="lg" />
                <code>surface.raised</code>
              </span>
            </div>
            <figcaption><TokenCopy name={`shadow.${shadow}`} /></figcaption>
          </figure>
        ))}
        <span className="foundation-plane-label"><code>surface.panel</code></span>
      </div>
      <p className="foundation-specimen-note">{t("foundations.shape.layerHint")}</p>
    </div>
  );
}
