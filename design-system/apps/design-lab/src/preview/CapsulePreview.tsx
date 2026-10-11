import { useState } from "react";
import { Button, Capsule, Icon, IconButton, Stack, Tooltip } from "@openbitfun/ui";
import { useI18n } from "../i18n";

export function CapsulePreview({ state = "default" }: { state?: string }) {
  const { t } = useI18n();
  const [removed, setRemoved] = useState<string[]>([]);
  const disabled = state === "disabled";
  return <Stack direction="horizontal" align="center" gap="3">
    {(["xs", "sm"] as const).filter(size => !removed.includes(size)).map(size => (
      <Capsule key={size} size={size} data-openbitfun-preview-state={state} action={(
        <Tooltip content={t("components.preview.close")} trigger="hover-focus">
          <IconButton aria-label={t("components.preview.close")} icon={<Icon name="xmark" />}
            disabled={disabled} onClick={() => setRemoved(current => [...current, size])} />
        </Tooltip>
      )}>
        <Button size={size} variant="outline" disabled={disabled}>{t("components.preview.modalProviderName")}</Button>
      </Capsule>
    ))}
    {removed.length > 0 && <Button size="sm" onClick={() => setRemoved([])}>{t("components.preview.add")}</Button>}
  </Stack>;
}
