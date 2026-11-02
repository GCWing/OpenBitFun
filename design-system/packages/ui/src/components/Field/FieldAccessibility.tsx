import { createContext, useContext, type AriaAttributes, type ReactNode } from "react";

type FieldAccessibility = Pick<AriaAttributes, "aria-labelledby" | "aria-describedby">;
const FieldAccessibilityContext = createContext<FieldAccessibility>({});

/** Associates a layout-owned label with controls, including controls inside wrappers.
 * Composite fields should give each child its own accessible name.
 */
export function FieldAccessibilityProvider({ children, ...value }: FieldAccessibility & { children: ReactNode }) {
  return <FieldAccessibilityContext.Provider value={value}>{children}</FieldAccessibilityContext.Provider>;
}

export function useFieldAccessibility(props: AriaAttributes, hasOwnLabel = false): FieldAccessibility {
  const inherited = useContext(FieldAccessibilityContext);
  return {
    "aria-labelledby": props["aria-labelledby"] ?? (
      props["aria-label"] || hasOwnLabel ? undefined : inherited["aria-labelledby"]
    ),
    "aria-describedby": [...new Set([
      props["aria-describedby"], inherited["aria-describedby"],
    ].filter(Boolean).flatMap(value => value!.split(/\s+/)))].join(" ") || undefined,
  };
}
