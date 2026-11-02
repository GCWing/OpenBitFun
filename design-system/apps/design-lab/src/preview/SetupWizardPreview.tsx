import { useEffect, useId, useState } from "react";
import { Button, Field, Input, SetupWizard, Switch } from "@openbitfun/ui";
import { useI18n } from "../i18n";
import "./SetupWizardPreview.css";

export function SetupWizardPreview({ state }: { state: string }) {
  const { t } = useI18n();
  const formId = useId();
  const [step, setStep] = useState<0 | 1 | 2>(state === "contained" ? 1 : 0);
  const [name, setName] = useState("");
  const [rules, setRules] = useState("");
  const [network, setNetwork] = useState(false);
  const [complete, setComplete] = useState(false);
  useEffect(() => { setStep(state === "contained" ? 1 : 0); setComplete(false); }, [state]);
  const steps = [
    { id: "basics", label: t("setupWizard.basics"), title: t("setupWizard.basicsTitle"), description: t("setupWizard.basicsDescription") },
    { id: "rules", label: t("setupWizard.rules"), title: t("setupWizard.rulesTitle"), description: t("setupWizard.rulesDescription") },
    { id: "access", label: t("setupWizard.access"), title: t("setupWizard.accessTitle"), description: t("setupWizard.accessDescription") },
  ] as const;
  const reset = () => { setStep(0); setName(""); setRules(""); setNetwork(false); setComplete(false); };

  return <div className="setup-wizard-preview" data-narrow={state === "narrow"}>
    <SetupWizard
      className="setup-wizard-preview__surface"
      title={t("setupWizard.title")}
      headerActions={<Button size="sm" variant="text" onClick={reset}>{t("setupWizard.reset")}</Button>}
      guideLabel={t("setupWizard.guide")}
      step={{ ...steps[step], progress: t("setupWizard.progress", { current: step + 1, total: steps.length }) }}
      contentMode={step === 1 ? "contained" : "scroll"}
      footer={<>
        {step > 0 && <Button size="sm" variant="outline" onClick={() => { setStep(step === 2 ? 1 : 0); setComplete(false); }}>{t("setupWizard.back")}</Button>}
        <Button type="submit" form={formId} size="sm" variant="primary">{t(step === 2 ? "setupWizard.finish" : "setupWizard.next")}</Button>
      </>}
    >
      <form id={formId} className="setup-wizard-preview__form" data-contained={step === 1} onSubmit={event => {
        event.preventDefault();
        if (step < 2) setStep(step === 0 ? 1 : 2);
        else setComplete(true);
      }}>
        {step === 0 && <Field label={t("setupWizard.name")}><Input placeholder={t("setupWizard.namePlaceholder")} value={name} onChange={event => setName(event.target.value)} /></Field>}
        {step === 1 && <>
          <label htmlFor={`${formId}-rules`}>{t("setupWizard.rules")}</label>
          <textarea id={`${formId}-rules`} className="setup-wizard-preview__editor" value={rules} onChange={event => setRules(event.target.value)} placeholder={t("setupWizard.rulesPlaceholder")} />
        </>}
        {step === 2 && <Field label={t("setupWizard.network")}><Switch checked={network} onCheckedChange={setNetwork} /></Field>}
        {complete && <p role="status">{t("setupWizard.complete")}</p>}
      </form>
    </SetupWizard>
    <p className="setup-wizard-preview__note">{t("setupWizard.help")}</p>
  </div>;
}
