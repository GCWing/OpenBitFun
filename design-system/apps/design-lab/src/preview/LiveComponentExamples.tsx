import { useId, useState } from "react";
import { Icon, SegmentedControl, TabGroup, type TabGroupSize } from "@openbitfun/ui";
import { MobileButton, MobileComposer, MobileDisclosure, MobileFloatingActions, MobileIconButton, MobileMessage, MobileScrim, MobileSegmentedControl } from "@openbitfun/ui/mobile";
import { useI18n } from "../i18n";

export function NavigationExample({ name, state, size = "sm" }: { name: string; state: string; size?: TabGroupSize }) {
  const { t } = useI18n();
  const id = useId();
  const [value, setValue] = useState(state === "unselected" ? "agent" : "chat");
  const options = [
    { label: t("components.preview.segmentedChat"), value: "chat" },
    { label: t("components.preview.segmentedAgent"), value: "agent", disabled: state === "disabled" },
  ];
  return <div className="design-navigation-example">
    {name === "TabGroup" ? <TabGroup aria-label={t("components.preview.tabGroupLabel")} value={value} onValueChange={setValue} size={size}
      data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
      items={options.map(option => ({ ...option, id: `${id}-${option.value}`, panelId: `${id}-${option.value}-panel` }))} />
      : name === "MobileSegmentedControl" ? <MobileSegmentedControl aria-label={t("components.preview.segmentedLabel")} value={value} onChange={setValue} options={options} />
        : <SegmentedControl aria-label={t("components.preview.segmentedLabel")} value={value} onValueChange={setValue} options={options} disabled={state === "disabled"}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined} />}
    {options.map(option => <section className="design-navigation-content" key={option.value} hidden={value !== option.value}
      id={`${id}-${option.value}-panel`} role={name === "TabGroup" ? "tabpanel" : undefined}
      aria-labelledby={name === "TabGroup" ? `${id}-${option.value}` : undefined} data-selected-content={option.value}>
      <strong>{option.label}</strong><p>{t(option.value === "chat" ? "components.preview.composerPlaceholder" : "components.preview.actionCardDescription")}</p>
    </section>)}
  </div>;
}

export function MobileDisclosureExample({ state }: { state: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(state === "open");
  return <MobileDisclosure disabled={state === "disabled"} onToggle={() => setOpen(value => !value)} open={open} title={t("components.preview.appearance")}>
    {t("components.preview.appearanceDescription")}
  </MobileDisclosure>;
}

export function MobileConversationExample({ name, state }: { name: string; state: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(state !== "collapsed");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  return <div className="design-mobile-conversation">
    <MobileMessage roleType="system">{t("components.preview.session")}</MobileMessage>
    <MobileMessage roleType="user">{t("design.contextUser")}</MobileMessage>
    <MobileMessage roleType="assistant">{t("design.contextAssistant")}</MobileMessage>
    {name === "MobileMessage" && <MobileMessage roleType={state === "user" || state === "system" ? state : "assistant"}>{t("design.contextAfter")}</MobileMessage>}
    {sent.map((message, index) => <MobileMessage key={index} roleType="user">{message}</MobileMessage>)}
    {name === "MobileComposer" && <MobileComposer expanded={expanded} onActivate={() => setExpanded(true)} aria-label={t("components.preview.composerLabel")}
      leading={<MobileIconButton appearance="plain" aria-label={t("components.preview.add")} icon={<Icon name="plus" />} onClick={() => setExpanded(true)} />}
      startActions={expanded ? <MobileButton appearance="plain" size="sm" onClick={() => setExpanded(false)}>{t("detail.option.collapsed")}</MobileButton> : undefined}
      endActions={<MobileIconButton appearance="plain" aria-label={t("components.preview.composerSend")} icon={<Icon name="arrow-up" />}
        disabled={!draft.trim()} onClick={() => { setSent(current => [...current, draft.trim()]); setDraft(""); }} />}>
      {expanded ? <textarea aria-label={t("components.preview.composerEditorLabel")} placeholder={t("components.preview.composerPlaceholder")}
        value={draft} onChange={event => setDraft(event.target.value)} /> : <span>{draft || t("components.preview.composerPlaceholder")}</span>}
    </MobileComposer>}
  </div>;
}

export function MobileFloatingActionsExample({ state }: { state: string }) {
  const { t } = useI18n();
  const [showComposer, setShowComposer] = useState(false);
  return <div className="design-mobile-footer-example" style={{ maxWidth: state === "narrow" ? 320 : undefined, paddingBottom: state === "safe-area" ? "var(--openbitfun-space-8)" : undefined }}>
    <MobileMessage roleType="assistant">{t("design.contextAssistant")}</MobileMessage>
    {showComposer && <MobileConversationExample name="MobileComposer" state="expanded" />}
    <MobileFloatingActions leading={<MobileButton onClick={() => setShowComposer(value => !value)}>{t("components.preview.add")}</MobileButton>}
      trailing={<MobileIconButton appearance="floating" aria-label={t("components.preview.close")} icon={<Icon name="xmark" />} disabled={!showComposer} onClick={() => setShowComposer(false)} />} />
  </div>;
}

export function MobileScrimExample({ state }: { state: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(state !== "hidden");
  return <section className="design-scrim-example">
    <MobileButton onClick={() => setOpen(true)}>{t("preview.scrim")}</MobileButton>
    <p>{t("preview.scrimHint")}</p>
    <MobileScrim aria-label={t("components.preview.close")} onClick={() => setOpen(false)} visible={open} />
  </section>;
}
