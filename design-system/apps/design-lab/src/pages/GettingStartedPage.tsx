import { Button, Icon as CatalogIcon } from "@openbitfun/ui";
import { GuideCodeCard, GuideStepList } from "../components/GuideContract";
import { useI18n } from "../i18n";

interface GettingStartedPageProps {
  onNavigate: (target: "components" | "resources" | "tokens") => void;
}

export function GettingStartedPage({ onNavigate }: GettingStartedPageProps) {
  const { t } = useI18n();

  return (
    <main className="lab-page lab-page--guide" id="getting-started">
      <header className="page-heading">
        <h1>{t("gettingStarted.title")}</h1>
      </header>

      {/* The block is shared with the homepage (see components/GuideContract): same steps, same
          snippet, so the two pages cannot describe the contract differently. */}
      <div className="guide-setup-layout">
        <GuideStepList />
        <GuideCodeCard />
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
