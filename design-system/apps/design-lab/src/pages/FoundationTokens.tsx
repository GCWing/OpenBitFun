import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";
import { Icon } from "@openbitfun/ui";
import { useI18n } from "../i18n";
import { editableTokenCatalog } from "../token-editor/catalog";

const tokensByName = new Map(editableTokenCatalog.map(token => [token.name, token]));

export function getToken(name: string) {
  const token = tokensByName.get(name);
  if (!token) throw new Error(`Unknown foundation token: ${name}`);
  return token;
}

export function cssToken(name: string): string {
  return `var(${getToken(name).cssVariable})`;
}

export function CopyValue({ value, label, children, className = "" }: {
  value: string;
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const feedback = state === "copied" ? t("detail.copied") : state === "failed" ? t("detail.copyUnavailable") : "";
  return (
    <button
      className={`foundation-copy ${className}`}
      type="button"
      aria-label={t("foundations.copy", { name: label })}
      title={feedback || value}
      data-copied={state === "copied" || undefined}
      onClick={async () => {
        setState("idle");
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {children ?? <code>{label}</code>}
      <span className="foundation-copy-feedback">
        <Icon glyph={Copy} size="xs" />
      </span>
      <span className={feedback ? "foundation-copy-result" : "foundation-sr-only"} role="status">
        {feedback && <Icon glyph={state === "copied" ? Check : CircleAlert} size="xs" />}
        {feedback}
      </span>
    </button>
  );
}

export function TokenCopy({ name }: { name: string }) {
  return <CopyValue value={cssToken(name)} label={name} />;
}


export function foundationTypeStyle(role: string): CSSProperties {
  const name = `type.${role}`;
  return {
    fontFamily: cssToken(`${name}.fontFamily`),
    fontSize: cssToken(`${name}.fontSize`),
    fontWeight: cssToken(`${name}.fontWeight`),
    lineHeight: cssToken(`${name}.lineHeight`),
    letterSpacing: cssToken(`${name}.letterSpacing`),
  };
}
