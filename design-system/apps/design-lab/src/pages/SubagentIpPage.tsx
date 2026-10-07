import { useRef, useState } from "react";
import { Button, Icon, TabGroup } from "@openbitfun/ui";
import {
  SUBAGENT_AVATAR_CATALOG,
  type SubagentAvatarId,
} from "../assets/subagentAvatars";
import { useI18n } from "../i18n";
import { SubagentMotionPreview } from "../preview/SubagentMotionPreview";
import "./SubagentIpPage.css";

const previewSizes = [20, 28, 40, 64] as const;

export function SubagentIpPage() {
  const { t } = useI18n();
  const [view, setView] = useState("gallery");
  const detailRef = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState<SubagentAvatarId>(SUBAGENT_AVATAR_CATALOG[0].id);
  const selectedAvatar = SUBAGENT_AVATAR_CATALOG.find((avatar) => avatar.id === selectedId)
    ?? SUBAGENT_AVATAR_CATALOG[0];

  function selectAvatar(id: SubagentAvatarId) {
    setSelectedId(id);
    const detail = detailRef.current;
    if (detail && detail.getBoundingClientRect().top >= window.innerHeight) {
      detail.scrollIntoView({ behavior: "instant", block: "start" });
    }
  }

  function previewMotion() {
    setView("motion");
    document.getElementById("subagent-motion-tab")?.focus();
  }

  return (
    <main className="lab-page lab-page--subagent-ip" id="subagent-ip">
      <header className="page-heading">
        <h1>{t("design.characters")}</h1>
      </header>

      <TabGroup
        aria-label={t("subagentMotion.tabs")}
        className="subagent-ip-tabs"
        items={[
          { value: "motion", label: t("subagentMotion.motionTab"), id: "subagent-motion-tab", panelId: "subagent-motion-panel" },
          { value: "gallery", label: t("subagentMotion.galleryTab"), id: "subagent-gallery-tab", panelId: "subagent-gallery-panel" },
        ]}
        onValueChange={setView}
        value={view}
      />
      <div aria-labelledby="subagent-motion-tab" hidden={view !== "motion"} id="subagent-motion-panel" role="tabpanel">
        {view === "motion" && <SubagentMotionPreview avatarId={selectedId} onAvatarChange={setSelectedId} />}
      </div>
      <div aria-labelledby="subagent-gallery-tab" hidden={view !== "gallery"} id="subagent-gallery-panel" role="tabpanel">
      <div className="subagent-ip-layout">
        <section aria-label={t("subagentIp.galleryLabel")}>
          <div className="subagent-ip-grid">
            {SUBAGENT_AVATAR_CATALOG.map((avatar) => (
              <button
                aria-controls="subagent-ip-detail"
                aria-pressed={avatar.id === selectedId}
                className="subagent-ip-card"
                key={avatar.id}
                onClick={() => selectAvatar(avatar.id)}
                type="button"
              >
                <img alt="" draggable={false} height={96} src={avatar.src} width={96} />
                <span>{t(`design.character.${avatar.id}`)}</span>
              </button>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="subagent-ip-detail-title"
          className="subagent-ip-detail"
          id="subagent-ip-detail"
          ref={detailRef}
        >
          <header className="subagent-ip-detail__heading">
            <h2 aria-live="polite" id="subagent-ip-detail-title">{t(`design.character.${selectedAvatar.id}`)}</h2>
          </header>
          <div className="subagent-ip-detail__art">
            <img
              alt={t("subagentIp.avatarAlt", { id: selectedAvatar.id })}
              draggable={false}
              height={192}
              src={selectedAvatar.src}
              width={192}
            />
          </div>
          <section aria-labelledby="subagent-ip-sizes-title" className="subagent-ip-sizes">
            <h3 id="subagent-ip-sizes-title">{t("subagentIp.sizesTitle")}</h3>
            <div className="subagent-ip-sizes__samples">
              {previewSizes.map((size) => (
                <figure key={size}>
                  <img alt="" draggable={false} height={size} src={selectedAvatar.src} width={size} />
                  <figcaption>{size} px</figcaption>
                </figure>
              ))}
            </div>
          </section>
          <Button onClick={previewMotion} variant="outline">{t("subagentMotion.viewMotion")}</Button>
          <a className="lab-text-link" download={`${selectedAvatar.id}.svg`} href={selectedAvatar.src}>
            <Icon aria-hidden="true" name="arrow-down" size="sm" />
            {t("subagentIp.download")}
          </a>
          <a href="#flow-chat">{t("design.inConversation")}</a>
        </section>
      </div>
      </div>
    </main>
  );
}
