import { createContext } from "react";

/** Capsule, tab, and card action slots own their floating presentation and geometry. */
export const FloatingActionContext = createContext<"xs" | "standard" | null>(null);
