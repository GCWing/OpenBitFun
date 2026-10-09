import { createContext, useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/Tooltip";
import { subscribeApplicationTitleTooltips, type TitleTooltipTarget } from "../internal/applicationTitleTooltips";
import { TitleTooltipContext } from "../internal/tooltipTriggerContext";

export const ApplicationTitleTooltipsContext = createContext(false);

/** Mounted once by the document's design-system provider, including its portals. */
export function ApplicationTitleTooltips({ ownerDocument }: { ownerDocument: Document }) {
  const [target, setTarget] = useState<(TitleTooltipTarget & { key: number }) | null>(null);
  useEffect(() => {
    let sequence = 0;
    return subscribeApplicationTitleTooltips(ownerDocument, next => setTarget(previous => {
      if (!next) return null;
      if (previous?.element === next.element) {
        return previous.text === next.text ? previous : { ...previous, text: next.text };
      }
      return { ...next, key: ++sequence };
    }));
  }, [ownerDocument]);
  const triggerRef = useMemo(() => ({ current: target?.element ?? null }), [target?.element]);
  return target && <TitleTooltipContext.Provider value>
    <Tooltip key={target.key} active content={target.text} trigger="hover-focus" triggerRef={triggerRef} />
  </TitleTooltipContext.Provider>;
}
