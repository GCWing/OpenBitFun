import { useEffect, useState } from "react";
import { Code2, Pause, Play } from "lucide-react";
import { SegmentedControl, Icon, IconButton, ThemeRoot } from "@openbitfun/ui";
import {
  OpenBitFunAppIcon,
  OpenBitFunBrandMotion,
  OpenBitFunMark,
  OpenBitFunSolidMark,
  SubagentHatch,
  VoiceParticleLogo,
  type SubagentHatchPhase,
} from "@openbitfun/ui/brand";
import { useI18n, type MessageKey } from "../i18n";
import { SUBAGENT_AVATAR_CATALOG } from "../assets/subagentAvatars";
import silverUrl from "../../../../packages/ui/src/brand/assets/openbitfun-app-mark.png?url";
import outlineUrl from "../../../../packages/ui/src/brand/assets/openbitfun-mark.svg?url";
import appPngUrl from "../../../../../assets/brand/exports/openbitfun-app-icon-512.png?url";
import appIcoUrl from "../../../../../assets/brand/exports/openbitfun-app-icon.ico?url";
import appIcnsUrl from "../../../../../assets/brand/exports/openbitfun-app-icon.icns?url";
import wordmarkUrl from "../../../../../png/openbitfun-wordmark.png?url";
import "./BrandPage.css";

type BrandResource = {
  name: string;
  label: MessageKey;
  description: MessageKey;
  specification?: string;
  motion?: boolean;
  downloads?: readonly { label: string; url: string; filename: string }[];
};

export const brandResources: readonly BrandResource[] = [
  {
    name: "OpenBitFunSolidMark", label: "design.silverMark",
    description: "brandAssets.silverDescription", specification: "PNG · 512 × 512",
    downloads: [{ label: "PNG", url: silverUrl, filename: "openbitfun-silver-mark.png" }],
  },
  {
    name: "OpenBitFunAppIcon", label: "design.appIcon",
    description: "brandAssets.appDescription", specification: "PNG · 512 × 512 / ICO / ICNS",
    downloads: [
      { label: "PNG", url: appPngUrl, filename: "openbitfun-app-icon-512.png" },
      { label: "ICO", url: appIcoUrl, filename: "openbitfun-app-icon.ico" },
      { label: "ICNS", url: appIcnsUrl, filename: "openbitfun-app-icon.icns" },
    ],
  },
  {
    name: "OpenBitFunMark", label: "design.lineMark", motion: true,
    description: "brandAssets.outlineDescription", specification: "SVG",
    downloads: [{ label: "SVG", url: outlineUrl, filename: "openbitfun-mark.svg" }],
  },
  {
    name: "wordmark", label: "design.wordmark",
    description: "brandAssets.wordmarkDescription", specification: "PNG · 2172 × 724",
    downloads: [{ label: "PNG", url: wordmarkUrl, filename: "openbitfun-wordmark.png" }],
  },
  {
    name: "OpenBitFunBrandMotion", label: "design.aboutMotion", motion: true,
    description: "brandAssets.aboutDescription",
  },
  {
    name: "VoiceParticleLogo", label: "design.voiceMotion", motion: true,
    description: "brandAssets.voiceDescription",
  },
];

/* The banner shows the family's own motion first: the hatch is the one animation the characters
   have, and the banner is where a reader meets the brand. The three mark motions stay one click
   away, because they are the brand's own vectors rather than product artwork. */
const motionScenes = [
  { name: "SubagentHatch", label: "brandAssets.characterMotion" },
  { name: "OpenBitFunMark", label: "brandAssets.breathe" },
  { name: "OpenBitFunBrandMotion", label: "brandAssets.flow" },
  { name: "VoiceParticleLogo", label: "brandAssets.particles" },
] as const;

/* The banner leads with the lilac character: the family keeps all twenty. */
const bannerCharacter = SUBAGENT_AVATAR_CATALOG.find(avatar => avatar.id === "robot-03") ?? SUBAGENT_AVATAR_CATALOG[0]!;
const bannerCharacterSize = 256;
type Background = "light" | "dark";
type OpenComponent = (name: string) => void;

function BackgroundPicker({ value, onChange, asset }: { value: Background; onChange: (value: Background) => void; asset: string }) {
  const { t } = useI18n();
  return (
    <div className="brand-gallery-backgrounds" role="group" aria-label={t("brandAssets.backgroundFor", { asset })}>
      {(["light", "dark"] as const).map(background => (
        <button key={background} type="button" data-scheme={background}
          aria-label={t(`settings.${background}`)} title={t(`settings.${background}`)}
          aria-pressed={value === background} onClick={() => onChange(background)}>
          <span />
        </button>
      ))}
    </div>
  );
}

function ComponentLink({ name, label, onOpen }: { name: string; label: string; onOpen: OpenComponent }) {
  const { t } = useI18n();
  const accessibleLabel = `${label} · ${t("design.relatedComponent")}`;
  return <IconButton aria-label={accessibleLabel} title={accessibleLabel} shape="circle"
    icon={<Icon glyph={Code2} size="sm" />} onClick={() => onOpen(name)} />;
}

function AssetActions({ resource, onOpenComponent }: { resource: BrandResource; onOpenComponent: OpenComponent }) {
  const { t } = useI18n();
  return (
    <div className="brand-gallery-actions">
      {resource.downloads?.map(asset => (
        <a className="brand-gallery-download" key={asset.filename} href={asset.url} download={asset.filename}
          aria-label={t("brandAssets.downloadLabel", { asset: t(resource.label), format: asset.label })}>
          <Icon name="arrow-down" size="xs" /><span>{asset.label}</span>
        </a>
      ))}
      {resource.name !== "wordmark" && <ComponentLink name={resource.name} label={t(resource.label)} onOpen={onOpenComponent} />}
    </div>
  );
}

function IdentityTile({ resource, onOpenComponent }: { resource: BrandResource; onOpenComponent: OpenComponent }) {
  const { t } = useI18n();
  const silver = resource.name === "OpenBitFunSolidMark";
  const app = resource.name === "OpenBitFunAppIcon";
  const [background, setBackground] = useState<Background>(silver ? "dark" : "light");
  const kind = silver ? "silver" : app ? "app" : "outline";
  return (
    <ThemeRoot className={`brand-gallery-tile brand-gallery-tile--${kind}`}
      colorScheme={background} density="compact" role="group" aria-labelledby={`brand-asset-${resource.name}`}>
      {!app && <div className="brand-gallery-tile-options">
        <BackgroundPicker value={background} onChange={setBackground} asset={t(resource.label)} />
      </div>}
      <div className="brand-gallery-tile-art">
        {silver ? <div className="brand-gallery-silver-art"><OpenBitFunSolidMark size={440} /></div>
          : app ? <OpenBitFunAppIcon size={144} />
          : <OpenBitFunMark size={112} />}
      </div>
      <div className="brand-gallery-tile-footer">
        <h2 id={`brand-asset-${resource.name}`}>{t(resource.label)}</h2>
        <AssetActions resource={resource} onOpenComponent={onOpenComponent} />
      </div>
    </ThemeRoot>
  );
}

function BrandMotionShowcase({ onOpenComponent }: { onOpenComponent: OpenComponent }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<(typeof motionScenes)[number]>(motionScenes[0]);
  const [playing, setPlaying] = useState(true);
  const [background, setBackground] = useState<Background>("dark");
  const [hatch, setHatch] = useState<SubagentHatchPhase>("incubating");
  const voice = selected.name === "VoiceParticleLogo";
  const character = selected.name === "SubagentHatch";
  /* The hatch is a one-shot reveal, so the banner runs it as a loop: the egg incubates, the
     character comes out, and the loop starts again. Pausing settles the character instead of
     freezing it mid-hatch, which is the state a reader wants to look at. */
  useEffect(() => {
    if (!character || !playing) {
      setHatch("ready");
      return;
    }
    let timer = 0;
    let incubating = true;
    setHatch("incubating");
    const step = () => {
      incubating = !incubating;
      setHatch(incubating ? "incubating" : "ready");
      timer = window.setTimeout(step, incubating ? 1800 : 3600);
    };
    timer = window.setTimeout(step, 1800);
    return () => window.clearTimeout(timer);
  }, [character, playing]);
  return (
    <section className="brand-gallery-section" id="brand-motion" aria-labelledby="brand-motion-title">
      <header className="brand-gallery-section-heading">
        <h2 id="brand-motion-title">{t("brandAssets.motionTitle")}</h2>
        <SegmentedControl className="brand-motion-selector" aria-label={t("brandAssets.chooseMotion")} tone="neutral"
          value={selected.name} onValueChange={value => setSelected(motionScenes.find(scene => scene.name === value) ?? motionScenes[0])}
          options={motionScenes.map(scene => ({ value: scene.name, label: t(scene.label) }))} />
      </header>
      <ThemeRoot className="brand-gallery-motion" id="brand-motion-stage"
        colorScheme={voice ? "dark" : background} density="compact"
        role="group" aria-label={t(selected.label)}>
        <div className="brand-gallery-motion-art" key={selected.name}>
          {/* The banner's own texture: the same mark drawn far larger than the frame and left
              unlit, so the silk runs off both edges instead of stopping inside the banner. It
              carries no label and never animates — the live graphic stays the one thing named
              here. Both marks take their size from the frame (see the stylesheet); passing the
              size prop would put an inline size on the mark and win over the frame. */}
          {!voice && !character && (
            <div className="brand-gallery-motion-texture" aria-hidden="true">
              {selected.name === "OpenBitFunMark"
                ? <OpenBitFunMark motion="breathe" active={false} />
                : <OpenBitFunBrandMotion active={false} />}
            </div>
          )}
          {character && (
            <SubagentHatch phase={hatch} size={bannerCharacterSize} active={playing}>
              <img src={bannerCharacter.src} alt="" draggable={false} width={bannerCharacterSize} height={bannerCharacterSize} />
            </SubagentHatch>
          )}
          {selected.name === "OpenBitFunMark" && <OpenBitFunMark size={216} motion="breathe" active={playing} />}
          {selected.name === "OpenBitFunBrandMotion" && <OpenBitFunBrandMotion size={320} active={playing} />}
          {voice && <div className="brand-gallery-voice"><VoiceParticleLogo active={playing} /></div>}
        </div>
        <div className="brand-gallery-motion-controls">
          {voice ? <span className="brand-gallery-idle">{t("brandAssets.voiceIdle")}</span>
            : <BackgroundPicker value={background} onChange={setBackground} asset={t(selected.label)} />}
          <div className="brand-gallery-actions">
            <IconButton shape="circle" variant="outline"
              aria-label={t(playing ? "brand.pause" : "brand.play")} title={t(playing ? "brand.pause" : "brand.play")}
              aria-pressed={playing} icon={<Icon glyph={playing ? Pause : Play} size="sm" />}
              onClick={() => setPlaying(value => !value)} />
            <ComponentLink name={selected.name} label={t(selected.label)} onOpen={onOpenComponent} />
          </div>
        </div>
      </ThemeRoot>
    </section>
  );
}

export function BrandPage({ onOpenComponent }: { onOpenComponent: OpenComponent }) {
  const { t } = useI18n();
  const wordmark = brandResources[3]!;
  return (
    <main className="lab-page brand-gallery" id="brand">
      <header className="brand-gallery-heading">
        <h1 id="brand-resource-title">{t("design.brand")}</h1>
        <nav className="brand-gallery-index" aria-label={t("design.brand")}>
          <a href="#brand/identity">{t("brandAssets.identityTitle")}</a>
          <a href="#brand/motion">{t("design.motion")}</a>
          <a href="#brand/characters">{t("brandAssets.charactersTitle")}</a>
        </nav>
      </header>

      <section className="brand-gallery-identity" id="brand-identity" aria-label={t("brandAssets.identityTitle")}>
        <div className="brand-gallery-grid">
          {brandResources.slice(0, 3).map(resource => (
            <IdentityTile key={resource.name} resource={resource} onOpenComponent={onOpenComponent} />
          ))}
        </div>
        <ThemeRoot className="brand-gallery-wordmark" colorScheme="light" density="compact">
          <h2>{t(wordmark.label)}</h2>
          <img src={wordmarkUrl} alt="OpenBitFun" width={2172} height={724} />
          <AssetActions resource={wordmark} onOpenComponent={onOpenComponent} />
        </ThemeRoot>
      </section>

      <BrandMotionShowcase onOpenComponent={onOpenComponent} />

      <section className="brand-gallery-section" id="brand-characters" aria-labelledby="brand-characters-title">
        <a className="brand-gallery-characters" href="#subagent-ip" aria-label={t("design.viewCharacters")}>
          <div className="brand-gallery-section-heading">
            <h2 id="brand-characters-title">{t("brandAssets.charactersTitle")}</h2>
            <Icon name="arrow-up-right" />
          </div>
          <div className="brand-gallery-family" aria-hidden="true">
            {SUBAGENT_AVATAR_CATALOG.slice(0, 6).map(avatar => (
              <img key={avatar.id} src={avatar.src} alt="" width={128} height={128} loading="lazy" />
            ))}
          </div>
        </a>
      </section>

      <details className="brand-gallery-notes" id="brand-usage">
        <summary>{t("brandAssets.usageTitle")}<Icon name="chevron-down" size="sm" /></summary>
        <div className="brand-gallery-notes-grid">
          {brandResources.map(resource => (
            <div key={resource.name}>
              <h3>{t(resource.label)}</h3>
              <p>{t(resource.description)}</p>
              {resource.specification && <span>{resource.specification}</span>}
              {resource.name === "OpenBitFunAppIcon" && (
                <div className="brand-gallery-size-list" role="group" aria-label={t("design.actualSize")}>
                  {[16, 24, 32, 48, 64].map(size => (
                    <figure key={size}><OpenBitFunAppIcon size={size} /><figcaption>{size} px</figcaption></figure>
                  ))}
                </div>
              )}
            </div>
          ))}
          <p className="brand-gallery-motion-note">{t("brandAssets.motionPreference")}</p>
        </div>
      </details>
    </main>
  );
}
