export type ComponentMaturity = "experimental" | "beta" | "stable" | "deprecated";

/* Platform is orthogonal to category: a surface ("where it runs") never becomes a category
   ("what it is"), so adding tablet, desktop or watch never renames an existing entry. */
export type ComponentPlatform = "web" | "mobile" | "tablet" | "desktop" | "watch";

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
  /* Defaults to a single platform derived from `category`, so an entry only states this
     explicitly when it is authored for several surfaces at once. */
  platforms?: readonly ComponentPlatform[];
  props: readonly ComponentPropMeta[];
  states: readonly string[];
  tokens: readonly string[];
}
