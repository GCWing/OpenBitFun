import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button, ComposerContextBar, ComposerDivider, Icon, IconButton, KeyHint, NavigationPanel, NavigationPanelBody, NavigationPanelContent, NavigationPanelFooter, NavigationPanelHeader, NavigationPanelItem, NavigationPanelSection, NumberBadge, PageHeader, SearchField, SegmentedControl, StatusPill, ThemeRoot, type IconName, type ThemeRootProps } from "@openbitfun/ui";
import { ChatComposer, ChatComposerActionButton } from "@openbitfun/ui/flow-chat";
import { OpenBitFunSolidMark, SubagentHatch, type SubagentHatchPhase } from "@openbitfun/ui/brand";
import { useI18n } from "../i18n";
import { SUBAGENT_AVATAR_CATALOG } from "../assets/subagentAvatars";
import { GuideCodeCard, GuideStepList } from "../components/GuideContract";
import { MultiSurfaceMorph } from "../preview/MultiSurfaceMorph";
import "./OverviewPage.css";

type OverviewTheme = Pick<ThemeRootProps, "colorScheme" | "contrast" | "density" | "tokenOverrides">;

interface OverviewPageProps extends OverviewTheme {
  onNavigate: (target: "components" | "foundations" | "brand" | "getting-started") => void;
}

/* The hero plays the family's own hatch rather than the static mark: the character resources are the
   part of the brand that moves, and the homepage is where a reader meets them first. It is the same
   character the brand gallery's motion banner leads with, so the page and the gallery agree on who
   the family's face is. */
const heroCharacter = SUBAGENT_AVATAR_CATALOG.find(avatar => avatar.id === "robot-03") ?? SUBAGENT_AVATAR_CATALOG[0]!;

/* The showcase frame is a picture of the product, so everything inside it is either a design system
   part or product data. Session and repository names, the machine, the version, and the model are
   data: they are literals here rather than copy in the message catalogs. */
type PreviewNavigationKey = "design.homePreview.assistant" | "design.homePreview.taskBoard"
  | "design.homePreview.miniApp" | "design.homePreview.extensions";

const previewNavigation: readonly { id: string; icon: IconName; label: PreviewNavigationKey }[] = [
  { id: "assistant", icon: "spark", label: "design.homePreview.assistant" },
  { id: "task-board", icon: "list-todo", label: "design.homePreview.taskBoard" },
  { id: "mini-app", icon: "mini-app", label: "design.homePreview.miniApp" },
  { id: "extensions", icon: "extension", label: "design.homePreview.extensions" },
];

/* Closing band. The product site's footer puts its own three communities beside the wordmark; the
   Lab has no community to send anyone to, so the three columns are the Lab's destinations — same
   shape, the Lab's content. */
const footerPathIcons: Record<"components" | "foundations" | "brand", IconName> = {
  components: "layers",
  foundations: "palette",
  brand: "star",
};

interface PreviewSessionRow {
  id: string;
  name: string;
  icon?: IconName;
  /** Child rows sit one step in from their parent, the way the product indents a session. */
  indent?: boolean;
  metadata?: ReactNode;
  selected?: boolean;
}

export function OverviewPage({ onNavigate, colorScheme, contrast, density, tokenOverrides }: OverviewPageProps) {
  const { t } = useI18n();
  const theme = { colorScheme, contrast, density, tokenOverrides };
  /* The hatch is a one-shot reveal, so the hero runs it as a loop: the egg incubates, the character
     comes out, hold, then incubate again. Off-screen and hidden-tab cases are handled inside the
     brand component's own motion hook, which suspends animation work it cannot show. */
  const [hatch, setHatch] = useState<SubagentHatchPhase>("incubating");
  const [hatchPlaying, setHatchPlaying] = useState(true);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setHatchPlaying(!preference.matches);
    sync();
    preference.addEventListener("change", sync);
    return () => preference.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!hatchPlaying) {
      // Reduced motion settles on the character rather than freezing an unopened egg.
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
  }, [hatchPlaying]);

  const previewSessions: readonly PreviewSessionRow[] = [
    { id: "claw", icon: "user", name: "Claw" },
    { id: "claw-session", indent: true, name: "New Claw Session" },
    { id: "openbitfun", icon: "folder", name: "OpenBitFun" },
    { id: "openbitfun-session", indent: true, name: "New Code Session" },
    { id: "openbitfun-welcome", indent: true, name: t("design.homePreview.welcome"), selected: true },
    { id: "openbitfun-more", name: t("design.homePreview.showMore"), metadata: <NumberBadge value="+14" /> },
    { id: "root", icon: "session", name: "root", metadata: <StatusPill emphasis tone="success">38.47.103.247</StatusPill> },
    { id: "root-session", indent: true, name: "New Code Session" },
    { id: "root-relay", indent: true, name: "relay-server account" },
    { id: "root-more", name: t("design.homePreview.showMore"), metadata: <NumberBadge value="+10" /> },
  ];

  return (
    <main className="lab-page lab-page--overview design-home" id="overview">
      <section className="design-home-hero" aria-labelledby="design-home-title">
        <div className="design-home-emblem" aria-hidden="true">
          <SubagentHatch className="design-home-character" phase={hatch} active={hatchPlaying}>
            <img className="design-home-character-avatar" src={heroCharacter.src} alt="" draggable={false} />
          </SubagentHatch>
        </div>
        <header className="design-home-heading">
          <h1 id="design-home-title" className="design-home-slogan">{t("design.slogan")}</h1>
          <p className="design-home-support">{t("design.sloganSupport")}</p>
          <div className="design-home-actions">
            <Button variant="primary" trailingIcon={<Icon name="arrow-right" />} onClick={() => onNavigate("components")}>{t("design.components")}</Button>
            <Button variant="secondary" onClick={() => onNavigate("getting-started")}>{t("nav.gettingStarted")}</Button>
          </div>
        </header>
      </section>

      <ThemeRoot className="design-home-preview" aria-hidden="true" {...{ inert: "" }} {...theme}>
        <MultiSurfaceMorph>
          <div className="design-home-preview-shell">
            {/* Sidebar: the design system's own NavigationPanel, so the picture is assembled from the
                same parts the product assembles it from. The panel keeps its block-fill selection and
                drops its footer rule — this frame separates regions with fills and space, not lines. */}
            <NavigationPanel className="design-home-preview-sidebar">
              <NavigationPanelHeader className="design-home-preview-search">
                <SearchField aria-label={t("design.homePreview.search")} leadingIcon={<Icon name="search" />}
                  placeholder={t("design.homePreview.search")} readOnly size="sm" tabIndex={-1}
                  shortcut={<KeyHint icon={<Icon name="command-mac" />}>K</KeyHint>} />
                <IconButton aria-label={t("design.homePreview.newSession")} icon={<Icon name="plus" />}
                  size="sm" tabIndex={-1} variant="fill" />
              </NavigationPanelHeader>
              <NavigationPanelBody scrollbarVisibility="hidden">
                <NavigationPanelContent>
                  <div className="design-home-preview-navigation">
                    {previewNavigation.map(item => (
                      <NavigationPanelItem key={item.id} className="design-home-preview-session"
                        leading={<Icon name={item.icon} />} tabIndex={-1}>{t(item.label)}</NavigationPanelItem>
                    ))}
                  </div>
                  <NavigationPanelSection title={t("design.homePreview.sessions")}>
                    {previewSessions.map(row => (
                      <NavigationPanelItem key={row.id} className={row.indent ? "design-home-preview-session design-home-preview-session--child" : "design-home-preview-session"}
                        leading={row.icon ? <Icon name={row.icon} /> : undefined} metadata={row.metadata} selected={row.selected} tabIndex={-1}>
                        {row.name}
                      </NavigationPanelItem>
                    ))}
                  </NavigationPanelSection>
                </NavigationPanelContent>
              </NavigationPanelBody>
              <NavigationPanelFooter className="design-home-preview-device">
                <span><Icon name="device-mac" />MacBook-Air</span>
                <IconButton aria-label={t("design.homePreview.settings")} icon={<Icon name="gear" />} size="sm" tabIndex={-1} variant="quiet" />
              </NavigationPanelFooter>
            </NavigationPanel>

            {/* Pane: the window the product opens on — its session tabs, then the welcome screen. */}
            <div className="design-home-preview-pane">
              <div className="design-home-preview-pane-head">
                <SegmentedControl aria-label={t("design.homePreview.sessions")} size="sm" tone="neutral" variant="pills"
                  value="welcome" options={[
                    { value: "welcome", label: t("design.homePreview.welcome") },
                    { value: "settings", label: t("design.homePreview.settings") },
                  ]} />
              </div>
              <div className="design-home-preview-stage">
                <div className="design-home-preview-welcome">
                  <OpenBitFunSolidMark className="design-app-mark design-home-preview-welcome-mark" size={48} />
                  {/* The product's welcome screen is a display PageHeader; the picture uses the same
                      part, so the greeting and its line keep the roles the product publishes. */}
                  <PageHeader align="center" className="design-home-preview-welcome-header" level={2} size="display"
                    title={t("design.homePreview.greeting")} description={t("design.homePreview.support")} />
                </div>
                <ChatComposer aria-label={t("components.preview.composerLabel")} className="design-home-preview-composer"
                  layout="expanded"
                  contextBar={(
                    <ComposerContextBar
                      leading={(
                        <>
                          <Button size="xs" tabIndex={-1} trailingIcon={<Icon name="chevron-down" />} variant="text">
                            {t("design.homePreview.contextMachine")}
                          </Button>
                          <ComposerDivider />
                          <Button size="xs" tabIndex={-1} trailingIcon={<Icon name="chevron-down" />} variant="text">OpenBitFun</Button>
                          <ComposerDivider />
                          <span className="design-home-preview-context">1.0.0-explore</span>
                          <ComposerDivider />
                          <span className="design-home-preview-context">
                            <Icon name="unselected" size="2xs" />
                            {t("design.homePreview.contextWorkspace")}
                          </span>
                        </>
                      )}
                      trailing={<StatusPill emphasis tone="success">{t("design.homePreview.contextAsk")}</StatusPill>}
                    />
                  )}
                  startActions={(
                    <Button size="sm" leadingIcon={<Icon name="plus" />} tabIndex={-1} variant="text">
                      {t("design.homePreview.mode")}
                    </Button>
                  )}
                  endActions={(
                    <>
                      <Button size="sm" tabIndex={-1} trailingIcon={<Icon name="chevron-down" />} variant="text">deepseek-v4-pro high</Button>
                      <ChatComposerActionButton aria-label={t("design.homePreview.composerVoice")} icon={<Icon name="mic" />}
                        tabIndex={-1} variant="fill" />
                      <ChatComposerActionButton aria-label={t("components.preview.composerSend")} icon={<Icon name="arrow-up" />}
                        tabIndex={-1} variant="primary" />
                    </>
                  )}>
                  <span className="design-home-preview-placeholder">{t("design.homePreview.composerPlaceholder")}</span>
                </ChatComposer>
              </div>
            </div>
          </div>
        </MultiSurfaceMorph>
      </ThemeRoot>

      {/* Usage: the guide's contract block, moved into the page's closing stretch so a reader who
          has seen the picture is told how the blocks are actually consumed before the footer sends
          them anywhere. Same steps and snippet as #getting-started (components/GuideContract). */}
      <section className="design-home-contract" aria-labelledby="design-home-contract-title">
        <h2 className="design-home-contract-title" id="design-home-contract-title">{t("gettingStarted.title")}</h2>
        <div className="guide-setup-layout">
          <GuideStepList headingLevel={3} />
          <GuideCodeCard />
        </div>
      </section>

      {/* Closing band: the product site's footer, adapted. It keeps that footer's shape — the
          prompt wordmark over its tagline, the three columns beside it, then the small print — and
          carries the Lab's own three destinations as the columns, because this is the page's last
          chance to send a reader somewhere. The band is the page's one filled region: it closes the
          page the way the reference closes its own, with the page's surface interrupted rather than
          another hairline drawn. */}
      <footer className="design-home-footer">
        <div className="design-home-footer-top">
          <div className="design-home-footer-identity">
            {/* The lockup is the way out of the Lab: same mark-and-name treatment as the topbar's
                own, now an outbound link to the product site. It leaves the Lab, so it opens in a
                new tab and carries the arrow that says so. */}
            <a className="design-home-footer-wordmark" href="https://openbitfun.com/" rel="noreferrer"
              target="_blank" aria-label={t("design.homeFooter.siteLabel")}>
              <span aria-hidden="true">&gt;_</span> OpenBitFun
              <Icon className="design-home-footer-wordmark-arrow" aria-hidden="true" name="arrow-up-right" size="sm" />
            </a>
            <p className="design-home-footer-tagline">
              {t("design.homeFooter.tagline")}<br />{t("design.homeFooter.taglineAccent")}
            </p>
            <span className="design-home-footer-steps" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
            </span>
          </div>
          <nav className="design-home-footer-paths" aria-label={t("design.homeFooter.pathsLabel")}>
            {(["components", "foundations", "brand"] as const).map(target => (
              <article className="design-home-footer-path" key={target}>
                <Icon className="design-home-footer-path-icon" name={footerPathIcons[target]} size="lg" />
                <h2>
                  <a href={`#${target}`} onClick={event => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onNavigate(target);
                  }}>
                    {t(`design.${target}`)}
                  </a>
                </h2>
                <p>{t(`design.${target}Intro`)}</p>
                {/* The reference sets the arrow on its own line under the paragraph; the column's
                    link overlay still covers it, so pointing at the arrow reaches the same page. */}
                <Icon aria-hidden="true" className="design-home-footer-path-arrow" name="arrow-right" />
              </article>
            ))}
          </nav>
        </div>
        <div className="design-home-footer-meta">
          <p>{t("design.homeFooter.copyright", { year: new Date().getFullYear() })}</p>
          <a href="mailto:hello@openbitfun.com" aria-label={t("design.homeFooter.contactLabel")}>
            {t("design.homeFooter.contact")}
          </a>
          <p>{t("design.homeFooter.openSource")}<span aria-hidden="true"> · </span>{t("design.homeFooter.license")}</p>
        </div>
      </footer>
    </main>
  );
}
