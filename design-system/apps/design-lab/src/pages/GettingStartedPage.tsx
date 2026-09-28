import { Button, Icon as CatalogIcon, type IconName } from "@openbitfun/ui";
import { Blocks, FileCode2, Layers3 } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";

interface GettingStartedPageProps {
  onNavigate: (target: "components" | "resources" | "tokens") => void;
}

const steps: readonly {
  description: MessageKey;
  icon: typeof Layers3 | IconName;
  title: MessageKey;
}[] = [
  {
    description: "gettingStarted.stepContractDescription",
    icon: Layers3,
    title: "gettingStarted.stepContractTitle",
  },
  {
    description: "gettingStarted.stepThemeDescription",
    icon: "palette",
    title: "gettingStarted.stepThemeTitle",
  },
  {
    description: "gettingStarted.stepComponentDescription",
    icon: Blocks,
    title: "gettingStarted.stepComponentTitle",
  },
];

export function GettingStartedPage({ onNavigate }: GettingStartedPageProps) {
  const { t } = useI18n();

  return (
    <main className="lab-page lab-page--guide" id="getting-started">
      <header className="page-heading">
        <h1>{t("gettingStarted.title")}</h1>
      </header>

      <div className="guide-setup-layout">
        <ol className="guide-step-list" aria-label={t("gettingStarted.stepsLabel")}>
          {steps.map(step => {
            const Icon = step.icon;
            return <li key={step.title}>
              <span className="guide-step-icon">{typeof Icon === "string" ? <CatalogIcon name={Icon} /> : <CatalogIcon glyph={Icon} />}</span>
              <div><h2>{t(step.title)}</h2><p>{t(step.description)}</p></div>
            </li>;
          })}
        </ol>
        <div className="guide-code-card">
          <div><CatalogIcon glyph={FileCode2} size="sm" /><span>App.tsx</span></div>
          <pre><code>{`import "@openbitfun/theme-openbitfun/default.css";
import "@openbitfun/ui/styles.css";
import { Button, ThemeRoot } from "@openbitfun/ui";

export function App() {
  return (
    <ThemeRoot colorScheme="light" density="compact">
      <Button variant="primary">Continue</Button>
    </ThemeRoot>
  );
}`}</code></pre>
        </div>
      </div>

      <div className="guide-next-action">
        <Button variant="text" onClick={() => onNavigate("components")} trailingIcon={<CatalogIcon name="arrow-right" size="sm" />}>
          {t("gettingStarted.browseComponents")}
        </Button>
        <Button variant="text" onClick={() => onNavigate("tokens")}>
          {t("gettingStarted.openTokens")}
        </Button>
        <Button variant="text" onClick={() => onNavigate("resources")} trailingIcon={<CatalogIcon name="arrow-right" size="sm" />}>
          {t("gettingStarted.viewResources")}
        </Button>
      </div>
    </main>
  );
}
