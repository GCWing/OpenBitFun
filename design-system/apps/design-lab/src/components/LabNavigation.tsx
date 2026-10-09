import { useI18n, type MessageKey } from "../i18n";

type Page = "components" | "foundations" | "brand" | "colors" | "tokens" | "getting-started" | "resources" | "patterns" | "flow-chat" | "flow-chat-mock" | "mobile" | "subagent-ip";
type NavigationProps = { page: string; componentName?: string; onNavigate: (page: Page) => void };
function sectionFor(page: string) {
  return ["brand", "subagent-ip"].includes(page) ? "brand"
    : ["foundations", "colors", "tokens", "getting-started", "resources"].includes(page) ? "foundations"
    : page === "overview" ? undefined : "components";
}
export function LabNavigation({ page, onNavigate }: NavigationProps) {
  const { t } = useI18n();
  return <nav aria-label={t("app.pagesLabel")} className="lab-navigation design-primary-navigation">
    {(["components", "foundations", "brand"] as const).map(target => <a key={target} href={`#${target}`} aria-current={sectionFor(page) === target ? "true" : undefined}
      onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(target); }}>{t(`design.${target}`)}</a>)}
  </nav>;
}
export function LabSectionNavigation({ page, onNavigate }: NavigationProps) {
  const { t } = useI18n();
  const section = sectionFor(page);
  const links: readonly [Page, MessageKey][] = section === "brand"
    ? [["brand", "design.identity"], ["subagent-ip", "design.characters"]]
    : section === "foundations"
      ? [["foundations", "design.foundations"], ["colors", "nav.colors"], ["tokens", "design.tokens"], ["getting-started", "nav.gettingStarted"], ["resources", "nav.resources"]]
      : section === "components"
        ? [["components", "design.all"], ["patterns", "design.contexts"], ["flow-chat-mock", "design.conversation"]]
        : [];
  if (!links.length) return null;
  return <nav className="design-secondary-navigation" aria-label={t(`design.${section!}`)}>
    {links.map(([target, label]) => <a key={target} href={`#${target}`} aria-current={page === target || (target === "components" && ["component", "mobile", "flow-chat"].includes(page)) ? "page" : undefined}
      onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(target); }}>{t(label)}</a>)}
  </nav>;
}
