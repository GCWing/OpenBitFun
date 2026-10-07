import { KeyHint, Select } from "@openbitfun/ui";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button, Icon, Input, StatusPill, Switch, type DensityMode } from "@openbitfun/ui";
import type { ThemeDataName } from "@openbitfun/theme-openbitfun";
import { useI18n, type MessageKey } from "../i18n";
import { nonColorTokenCatalog } from "../token-editor/catalog";
import { CopyValue, TokenCopy, cssToken, getToken, foundationTypeStyle } from "./FoundationTokens";
import { ColorRelationships, SpacingExplorer, ShapeExplorer, TypographyComposition } from "./FoundationSpecimens";
import "./FoundationsPage.css";

const sections = [
  { id: "colors", label: "nav.colors", note: "design.colorNote" },
  { id: "type", label: "design.type", note: "design.typeNote" },
  { id: "space", label: "design.space", note: "design.spaceNote" },
  { id: "shape", label: "design.shape", note: "design.shapeNote" },
  { id: "motion", label: "design.motion", note: "design.motionNote" },
  { id: "accessibility", label: "design.accessibility", note: "design.accessibilityNote" },
] as const satisfies readonly { id: string; label: MessageKey; note: MessageKey }[];
type FoundationSection = typeof sections[number]["id"];

const typeRoles = ["heading.page", "heading.section", "body.lg", "body.md", "label.md", "code.sm"] as const;
const modes = ["light", "dark", "highContrastLight", "highContrastDark"] as const;
const densities = ["compact", "comfortable", "touch"] as const;
function durationInMs(value: string) {
  return parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
}
const durationTokens = nonColorTokenCatalog.filter(token => /^motion\.duration\./.test(token.name))
  .sort((a, b) => durationInMs(a.values.compact!) - durationInMs(b.values.compact!));

function MotionDurationSample({ name, value, replayVersion }: {
  name: string;
  value: string;
  replayVersion: number;
}) {
  const [localReplay, setLocalReplay] = useState(0);
  const replay = () => setLocalReplay(current => current + 1);
  return (
    <div className="foundation-motion-row"
      onPointerEnter={event => { if (event.pointerType !== "touch") replay(); }}
      onFocus={event => { if (!event.currentTarget.contains(event.relatedTarget)) replay(); }}>
      <TokenCopy name={name} />
      <div className="foundation-motion-track" aria-hidden="true" style={{ "--_foundation-duration": cssToken(name) } as CSSProperties}>
        <span key={`${replayVersion}:${localReplay}`} className="foundation-motion-travel" data-playing={replayVersion > 0 || localReplay > 0 || undefined}><i /></span>
      </div>
      <code>{value}</code>
    </div>
  );
}

function Chapter({ id, children, action }: {
  id: FoundationSection;
  children: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useI18n();
  const index = sections.findIndex(section => section.id === id);
  const section = sections[index]!;
  return (
    <section className="foundation-chapter" id={`foundation-${id}`} aria-labelledby={`foundation-${id}-title`}>
      <header className="foundation-chapter-heading">
        <div>
          <h2 id={`foundation-${id}-title`} tabIndex={-1}>{t(section.label)}</h2>
          <p>{t(section.note)}</p>
        </div>
        {action && <div className="foundation-chapter-action">{action}</div>}
      </header>
      {children}
    </section>
  );
}

interface FoundationsPageProps {
  density: DensityMode;
  mode: ThemeDataName;
  onDensityChange: (density: DensityMode) => void;
  onModeChange: (mode: ThemeDataName) => void;
  onNavigate: (page: "colors" | "tokens") => void;
}

export function FoundationsPage({ density, mode, onDensityChange, onModeChange, onNavigate }: FoundationsPageProps) {
  const { t } = useI18n();
  const pageRef = useRef<HTMLElement>(null);
  const indexRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<FoundationSection>("colors");
  const [sampleText, setSampleText] = useState("");
  const [motionReplay, setMotionReplay] = useState(0);
  const [exampleEnabled, setExampleEnabled] = useState(false);
  const defaultSample = `OpenBitFun — ${t("design.foundations")}`;
  const tokenValue = (name: string) => {
    const token = getToken(name);
    return token.values[token.collection === "system" ? density : mode]!;
  };

  useEffect(() => {
    let scrollFrame = 0;
    let navigationFrame = 0;
    const chapters = sections.map(section => pageRef.current?.querySelector<HTMLElement>(`#foundation-${section.id}`));
    function updatePosition() {
      scrollFrame = 0;
      let current: FoundationSection = "colors";
      chapters.forEach((chapter, index) => {
        if (chapter && chapter.getBoundingClientRect().top <= parseFloat(getComputedStyle(chapter).scrollMarginTop) + 24) {
          current = sections[index]!.id;
        }
      });
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) current = "accessibility";
      setActiveSection(current);
    }
    function onScroll() {
      if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updatePosition);
    }
    function syncAnchor(initial = false) {
      if (!/^#foundations(?:\/|$)/i.test(window.location.hash)) return;
      window.cancelAnimationFrame(navigationFrame);
      navigationFrame = window.requestAnimationFrame(() => {
        const id = window.location.hash.slice("#foundations/".length).toLowerCase();
        const section = sections.find(item => item.id === id);
        const behavior = initial || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
        if (section) {
          const element = pageRef.current?.querySelector<HTMLElement>(`#foundation-${section.id}`);
          element?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
          element?.scrollIntoView({ behavior, block: "start" });
          setActiveSection(section.id);
        } else {
          window.scrollTo({ top: 0, behavior });
          setActiveSection("colors");
        }
      });
    }
    const onHashChange = () => syncAnchor();
    syncAnchor(true);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.cancelAnimationFrame(scrollFrame);
      window.cancelAnimationFrame(navigationFrame);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  useEffect(() => {
    const index = indexRef.current;
    const current = index?.querySelector<HTMLElement>("[aria-current]");
    if (!index || !current || index.scrollWidth <= index.clientWidth) return;
    const left = current.getBoundingClientRect().left - index.getBoundingClientRect().left;
    if (left < 0 || left + current.offsetWidth > index.clientWidth) {
      // Move only the horizontal index; keep the reader's document position.
      index.scrollTo({
        left: index.scrollLeft + left - (index.clientWidth - current.offsetWidth) / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    }
  }, [activeSection]);

  return (
    <main className="lab-page design-foundations" id="foundations" ref={pageRef}>
      <header className="foundation-page-heading">
        <div className="page-heading">
          <h1>{t("design.foundations")}</h1>
        </div>
        <div className="foundation-environment" role="group" aria-label={t("foundations.environment")}>
          <div>
            <label>
              <span>{t("colors.mode")}</span>
              <Select aria-label={t("colors.mode")} value={mode} onValueChange={value => onModeChange(value as ThemeDataName)}
                options={modes.map(value => ({ value, label: t(`colors.mode.${value}`) }))} />
            </label>
            <label>
              <span>{t("settings.density")}</span>
              <Select aria-label={t("settings.density")} value={density} onValueChange={value => onDensityChange(value as DensityMode)}
                options={densities.map(value => ({ value, label: t(`settings.${value}`) }))} />
            </label>
          </div>
        </div>
      </header>

      <div className="foundation-layout">
        <aside className="foundation-sidebar">
          <nav className="foundation-index" aria-label={t("foundations.contents")} ref={indexRef}>
            {sections.map(section => (
              <a key={section.id} href={`#foundations/${section.id}`} aria-current={activeSection === section.id ? "location" : undefined}
                onClick={event => {
                  if (window.location.hash !== `#foundations/${section.id}`) return;
                  event.preventDefault();
                  const element = pageRef.current?.querySelector<HTMLElement>(`#foundation-${section.id}`);
                  element?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
                  element?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
                }}>
                {t(section.label)}
              </a>
            ))}
          </nav>
          <a className="foundation-workbench-link" href="#tokens" onClick={event => { event.preventDefault(); onNavigate("tokens"); }}>
            {t("design.tokens")}<Icon name="arrow-up-right" size="sm" />
          </a>
        </aside>

        <div className="foundation-content">
          <Chapter id="colors" action={<Button variant="text" size="sm" onClick={() => onNavigate("colors")} trailingIcon={<Icon name="arrow-right" />}>{t("foundations.allColors")}</Button>}>
            <ColorRelationships tokenValue={tokenValue} />
          </Chapter>

          <Chapter id="type">
            <TypographyComposition />
            <details className="foundation-type-details">
              <summary>{t("foundations.type.inspect")}</summary>
              <div className="foundation-type-toolbar">
                <label htmlFor="foundation-type-input">{t("foundations.tryType")}</label>
                <Input id="foundation-type-input" value={sampleText} onValueChange={setSampleText} placeholder={defaultSample} maxLength={160} />
                <Button variant="text" size="sm" disabled={!sampleText} onClick={() => setSampleText("")}>{t("foundations.reset")}</Button>
              </div>
              <div className="foundation-type-specimens">
                {typeRoles.map(role => {
                  const name = `type.${role}`;
                  const style = foundationTypeStyle(role);
                  const declaration = Object.entries(style).map(([property, value]) => `${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}: ${value};`).join("\n");
                  return <div className="foundation-type-row" key={role}>
                    <div className="foundation-type-meta">
                      <span>{t(`foundations.type.${role}`)}</span>
                      <CopyValue label={name} value={declaration} />
                      <dl>
                        <div><dt>{t("foundations.fontSize")}</dt><dd>{tokenValue(`${name}.fontSize`)}</dd></div>
                        <div><dt>{t("foundations.lineHeight")}</dt><dd>{tokenValue(`${name}.lineHeight`)}</dd></div>
                        <div><dt>{t("foundations.weight")}</dt><dd>{tokenValue(`${name}.fontWeight`)}</dd></div>
                      </dl>
                    </div>
                    <div className="foundation-type-sample" style={style}>{sampleText || defaultSample}</div>
                  </div>;
                })}
              </div>
            </details>
          </Chapter>

          <Chapter id="space">
            <SpacingExplorer tokenValue={tokenValue} />
          </Chapter>

          <Chapter id="shape">
            <ShapeExplorer tokenValue={tokenValue} />
          </Chapter>

          <Chapter id="motion" action={<Button variant="outline" size="sm" aria-controls="foundation-motion-samples" onClick={() => setMotionReplay(current => current + 1)} leadingIcon={<Icon glyph={RotateCcw} size="sm" />}>{t("foundations.replay")}</Button>}>
            <div className="foundation-specimen-label"><span>{t("foundations.duration")}</span><TokenCopy name="motion.easing.standard" /></div>
            <div className="foundation-motion-list" id="foundation-motion-samples">
              {durationTokens.map(token => <MotionDurationSample key={token.name} name={token.name} value={tokenValue(token.name)} replayVersion={motionReplay} />)}
            </div>
            <p className="foundation-specimen-note">{t("foundations.motion.compareHint")}</p>
            <p className="foundation-motion-reduced" role="status">{t("foundations.reducedMotion")}</p>
          </Chapter>

          <Chapter id="accessibility">
            <div className="foundation-accessibility-example">
              <div>
                <h3>{t("foundations.keyboard")}</h3>
                <p>{t("foundations.keyboardHint")}</p>
                <div className="foundation-keyboard-keys" aria-hidden="true"><KeyHint>Tab</KeyHint><Icon name="arrow-right" size="sm" /><KeyHint>Space</KeyHint></div>
              </div>
              <div className="foundation-switch-example">
                <label htmlFor="foundation-example-switch">{t("foundations.exampleControl")}</label>
                <Switch id="foundation-example-switch" checked={exampleEnabled} onCheckedChange={setExampleEnabled} />
                <StatusPill tone={exampleEnabled ? "success" : "neutral"} role="status" leading={<Icon glyph={exampleEnabled ? Check : RotateCcw} size="xs" />}>
                  {t(exampleEnabled ? "foundations.enabled" : "foundations.disabled")}
                </StatusPill>
              </div>
            </div>
          </Chapter>

          <footer className="foundation-next-step">
            <Button onClick={() => onNavigate("tokens")} trailingIcon={<Icon name="arrow-right" />}>{t("foundations.openTokens")}</Button>
          </footer>
        </div>
      </div>
    </main>
  );
}
