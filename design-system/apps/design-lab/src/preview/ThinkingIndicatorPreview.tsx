import { useState } from "react";
import { Button, ThinkingIndicator } from "@openbitfun/ui";
import { useI18n } from "../i18n";
import "./ThinkingIndicatorPreview.css";

/** Live public component specimens; the controls only set its active property. */
export function ThinkingIndicatorPreview({ state }: { state: string }) {
  const { t } = useI18n();
  const [active, setActive] = useState(state !== "static");
  return <div className="thinking-indicator-preview">
    <div className="thinking-indicator-preview__heading">
      <strong>{t("thinkingIndicator.title")}</strong>
      <p>{t("thinkingIndicator.route")}</p>
    </div>
    <div className="thinking-indicator-preview__detail">
      <div className="thinking-indicator-preview__enlarged">
        <ThinkingIndicator active={active} size="lg" label={t("thinkingIndicator.label")} />
      </div>
      <span>{t("thinkingIndicator.detail")}</span>
    </div>
    <div className="thinking-indicator-preview__controls">
      <Button onClick={() => setActive(value => !value)} size="sm">
        {t(active ? "thinkingIndicator.stop" : "thinkingIndicator.play")}
      </Button>
    </div>
    <div className="thinking-indicator-preview__sizes">
      <strong>{t("thinkingIndicator.sizes")}</strong>
      <div className="thinking-indicator-preview__size-row">
        {(["2xs", "xs", "sm", "md", "lg"] as const).map(size => <div className="thinking-indicator-preview__specimen" key={size}>
          <ThinkingIndicator active={active} size={size} />
          <span>{size}</span>
        </div>)}
      </div>
    </div>
    <p className="thinking-indicator-preview__note">{t("thinkingIndicator.note")}</p>
  </div>;
}
