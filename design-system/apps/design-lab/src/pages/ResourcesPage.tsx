import { Icon as CatalogIcon, type IconName } from "@openbitfun/ui";
import { BookOpen, Boxes, FileCode2, FileText, ShieldCheck } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";

const repositoryBase = "https://github.com/GCWing/OpenBitFun/blob/main/design-system";

const resources: readonly {
  description: MessageKey;
  href: string;
  icon: typeof BookOpen | IconName;
  title: MessageKey;
}[] = [
  {
    description: "resources.designSystemDescription",
    href: `${repositoryBase}/README.md`,
    icon: BookOpen,
    title: "resources.designSystemTitle",
  },
  {
    description: "resources.uiDescription",
    href: `${repositoryBase}/packages/ui/README.md`,
    icon: Boxes,
    title: "resources.uiTitle",
  },
  {
    description: "resources.tokensDescription",
    href: `${repositoryBase}/packages/design-tokens/README.md`,
    icon: FileCode2,
    title: "resources.tokensTitle",
  },
  {
    description: "resources.themeDescription",
    href: `${repositoryBase}/packages/theme-openbitfun/README.md`,
    icon: "palette",
    title: "resources.themeTitle",
  },
  {
    description: "resources.releaseDescription",
    href: `${repositoryBase}/docs/release-policy.md`,
    icon: ShieldCheck,
    title: "resources.releaseTitle",
  },
  {
    description: "resources.contributorDescription",
    href: `${repositoryBase}/AGENTS.md`,
    icon: FileText,
    title: "resources.contributorTitle",
  },
];

export function ResourcesPage() {
  const { t } = useI18n();

  return (
    <main className="lab-page lab-page--resources" id="resources">
      <header className="page-heading">
        <h1>{t("resources.title")}</h1>
      </header>

      <section className="resource-grid" aria-label={t("resources.libraryLabel")}>
        {resources.map((resource) => {
          const Icon = resource.icon;
          return (
            <a href={resource.href} key={resource.title} rel="noreferrer" target="_blank">
              <span className="resource-card-icon">{typeof Icon === "string" ? <CatalogIcon name={Icon} size="lg" /> : <CatalogIcon glyph={Icon} size="lg" />}</span>
              <span>
                <strong>{t(resource.title)}</strong>
                <small>{t(resource.description)}</small>
              </span>
              <CatalogIcon name="arrow-up-right" size="md" aria-hidden="true" />
            </a>
          );
        })}
      </section>

    </main>
  );
}
