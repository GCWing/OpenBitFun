export type ComponentMaturity = "experimental" | "beta" | "stable" | "deprecated";

export interface ComponentPropMeta {
  defaultValue?: string;
  name: string;
  type: string;
}

export interface ComponentMeta {
  category: "primitive" | "action" | "form" | "feedback" | "navigation" | "flow-chat" | "mobile" | "brand";
  description: string;
  maturity: ComponentMaturity;
  name: string;
  props: readonly ComponentPropMeta[];
  states: readonly string[];
  tokens: readonly string[];
}
