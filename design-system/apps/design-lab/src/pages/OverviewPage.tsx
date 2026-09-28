import { Button, Icon, StatusPill, Switch } from "@openbitfun/ui";
import { OpenBitFunMark } from "@openbitfun/ui/brand";
import { SUBAGENT_AVATAR_CATALOG } from "../assets/subagentAvatars";
import { useI18n } from "../i18n";
import "./OverviewPage.css";

interface OverviewPageProps {
  onNavigate: (target: "components" | "foundations" | "brand" | "getting-started") => void;
}

export function OverviewPage({ onNavigate }: OverviewPageProps) {
  const { t } = useI18n();

  return (
    <main className="lab-page lab-page--overview design-home" id="overview">
      <section className="design-home-hero" aria-labelledby="design-home-title">
        <header className="design-home-heading">
          <h1 id="design-home-title">
            <span className="design-home-name">OpenBitFun</span>{" "}
            <span className="design-home-title">Design</span>
          </h1>
          <p className="design-home-description">{t("design.intro")}</p>
          <div className="design-home-actions">
            <Button variant="primary" trailingIcon={<Icon name="arrow-right" />} onClick={() => onNavigate("components")}>{t("design.components")}</Button>
            <Button variant="text" onClick={() => onNavigate("getting-started")}>{t("nav.gettingStarted")}</Button>
          </div>
        </header>
        <div className="design-home-emblem" aria-hidden="true">
          <OpenBitFunMark className="design-home-mark" motion="breathe" />
        </div>
      </section>
      <div className="design-destination-grid">
        {(["components", "foundations", "brand"] as const).map(target => (
          <article className="design-destination" key={target}>
            <div className="design-destination-copy">
              <h2>
                <a href={`#${target}`} aria-describedby={`design-${target}-description`} onClick={event => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onNavigate(target);
                }}>
                  {t(`design.${target}`)}
                  <Icon name="arrow-up-right" className="design-destination-arrow" />
                </a>
              </h2>
              <p id={`design-${target}-description`}>{t(`design.${target}Intro`)}</p>
            </div>
            <div className={`design-destination-specimen design-destination-specimen--${target}`} aria-hidden="true" {...{ inert: "" }}>
              {target === "components" ? (
                <>
                  <Button size="sm" variant="fill" tabIndex={-1}>OpenBitFun</Button>
                  <Switch defaultChecked aria-label={t("components.preview.session")} tabIndex={-1} />
                  <StatusPill tone="neutral">{t("components.preview.session")}</StatusPill>
                </>
              ) : target === "foundations" ? (
                <>
                  <span className="design-home-type-sample">Aa</span>
                  <div className="design-home-palette"><i /><i /><i /><i /></div>
                </>
              ) : SUBAGENT_AVATAR_CATALOG.slice(0, 3).map(avatar => (
                <img key={avatar.id} src={avatar.src} alt="" width={44} height={44} loading="lazy" />
              ))}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
