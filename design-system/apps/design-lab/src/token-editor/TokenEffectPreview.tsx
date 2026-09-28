import { componentRegistry } from "@openbitfun/ui/registry";
import { ComponentCardPreview } from "../pages/ComponentsPage";
import { Button, Stack, Switch } from "@openbitfun/ui";
import { useI18n } from "../i18n";

export function TokenEffectPreview({ componentName }: { componentName?: string }) {
  const { t } = useI18n();

  const component = componentRegistry.find(item => item.name === componentName);
  if (component) return <section className="design-token-owner-preview"><span className="page-kicker">{t("design.selectedComponent")}</span><h2>{component.name}</h2><div><ComponentCardPreview component={component} /></div><a href={`#component/${component.name.toLowerCase()}`}>{t("design.relatedComponent")}</a></section>;

  return (
    <div className="token-effect-preview">
      <header className="effect-preview-heading">
        <div>
          <span className="lab-eyebrow">{t("effect.eyebrow")}</span>
          <h2>{t("effect.title")}</h2>
        </div>
        <span>{t("effect.subtitle")}</span>
      </header>

      <div className="effect-preview-grid">
        <section className="effect-card effect-card--surfaces">
          <span className="effect-card-label">{t("effect.surfaces")}</span>
          <div className="surface-samples">
            <div className="surface-sample surface-sample--canvas">{t("effect.canvas")}</div>
            <div className="surface-sample surface-sample--panel">{t("effect.panel")}</div>
            <div className="surface-sample surface-sample--subtle">{t("effect.subtle")}</div>
            <div className="surface-sample surface-sample--raised">{t("effect.raised")}</div>
          </div>
        </section>

        <section className="effect-card effect-card--type">
          <span className="effect-card-label">{t("effect.typography")}</span>
          <div className="type-samples">
            <span className="type-sample-display">{t("effect.display")}</span>
            <span className="type-sample-title">{t("effect.interfaceTitle")}</span>
            <span className="type-sample-body">{t("effect.body")}</span>
            <span className="type-sample-caption">{t("effect.caption")}</span>
          </div>
        </section>

        <section className="effect-card effect-card--components">
          <span className="effect-card-label">{t("effect.components")}</span>
          <Stack gap="4">
            <Stack align="center" direction="horizontal" gap="2" wrap>
              <Button variant="fill">{t("effect.filled")}</Button>
              <Button variant="outline">{t("effect.outline")}</Button>
            </Stack>
            <Stack align="center" direction="horizontal" gap="3" wrap>
              <Switch aria-label={t("components.preview.notifications")} />
              <Switch
                aria-label={t("components.preview.notifications")}
                defaultChecked
              />
            </Stack>
          </Stack>
        </section>

        <section className="effect-card effect-card--system">
          <span className="effect-card-label">{t("effect.geometry")}</span>
          <div className="geometry-samples">
            <div className="geometry-sample geometry-sample--split-view-panel">
              <strong>layout.splitView.contentPanelRadius</strong>
              {t("effect.panelCorners")}
            </div>
            <div className="geometry-sample">
              <strong>space.3</strong>
              {t("effect.componentGaps")}
            </div>
            <div className="geometry-sample">
              <strong>motion.duration.normal</strong>
              {t("effect.motionNormal")}
            </div>
          </div>
        </section>

        <section className="effect-card effect-card--status">
          <span className="effect-card-label">{t("effect.status")}</span>
          <div className="status-samples">
            <span data-tone="info"><i aria-hidden="true" />{t("effect.info")}</span>
            <span data-tone="success"><i aria-hidden="true" />{t("effect.success")}</span>
            <span data-tone="warning"><i aria-hidden="true" />{t("effect.warning")}</span>
            <span data-tone="danger"><i aria-hidden="true" />{t("effect.danger")}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
