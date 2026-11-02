import { Icon as CatalogIcon, type IconName } from "@openbitfun/ui";
import { Blocks, FileCode2, Layers3 } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";

/* The usage block the guide opens with and the homepage closes on: three steps of the package
   contract beside the imports they add up to. One source, two homes — the homepage would otherwise
   carry a second copy of the snippet and drift from it. */

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

const snippet = `import "@openbitfun/theme-openbitfun/default.css";
import "@openbitfun/ui/styles.css";
import { Button, ThemeRoot } from "@openbitfun/ui";

export function App() {
  return (
    <ThemeRoot colorScheme="light" density="compact">
      <Button variant="primary">Continue</Button>
    </ThemeRoot>
  );
}`;

interface GuideStepListProps {
  /** The guide puts the steps under its page title, so they are h2; a page that nests them under
      its own section title needs h3. One list, whichever level the outline asks for. */
  headingLevel?: 2 | 3;
}

export function GuideStepList({ headingLevel = 2 }: GuideStepListProps) {
  const { t } = useI18n();
  const StepHeading = headingLevel === 3 ? "h3" : "h2";

  return (
    <ol className="guide-step-list" aria-label={t("gettingStarted.stepsLabel")}>
      {steps.map(step => {
        const Icon = step.icon;
        return <li key={step.title}>
          <span className="guide-step-icon">{typeof Icon === "string" ? <CatalogIcon name={Icon} /> : <CatalogIcon glyph={Icon} />}</span>
          <div><StepHeading>{t(step.title)}</StepHeading><p>{t(step.description)}</p></div>
        </li>;
      })}
    </ol>
  );
}

export function GuideCodeCard() {
  return (
    <div className="guide-code-card">
      <div><CatalogIcon glyph={FileCode2} size="sm" /><span>App.tsx</span></div>
      <pre><code>{snippet}</code></pre>
    </div>
  );
}
