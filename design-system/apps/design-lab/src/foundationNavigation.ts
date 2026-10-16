import type { MessageKey } from "./i18n";

/* The Foundations chapters. One list, two consumers: the page renders each entry as a section, and
   the rail renders the same entries as the children of the Foundations route, so the tree in the
   rail and the document can never drift apart. */
export const foundationSections = [
  { id: "colors", label: "nav.colors", note: "design.colorNote" },
  { id: "type", label: "design.type", note: "design.typeNote" },
  { id: "space", label: "design.space", note: "design.spaceNote" },
  { id: "shape", label: "design.shape", note: "design.shapeNote" },
  { id: "motion", label: "design.motion", note: "design.motionNote" },
  { id: "accessibility", label: "design.accessibility", note: "design.accessibilityNote" },
] as const satisfies readonly { id: string; label: MessageKey; note: MessageKey }[];

export type FoundationSectionId = typeof foundationSections[number]["id"];

/* The reader's position belongs to the page: it is the only part that measures scroll geometry.
   It publishes the current chapter here so the rail's tree can mark it, and the shell never has to
   know how the page measures itself. */
let activeSection: FoundationSectionId = "colors";
const listeners = new Set<() => void>();

export function getActiveFoundationSection() {
  return activeSection;
}

export function subscribeFoundationSection(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setActiveFoundationSection(id: FoundationSectionId) {
  if (id === activeSection) return;
  activeSection = id;
  for (const listener of listeners) listener();
}

/* Move the reader to a chapter the way a hash change would. Used for the initial anchor and for
   clicking the chapter already in the address, where no hash change will follow. */
export function focusFoundationSection(id: FoundationSectionId, behavior?: ScrollBehavior) {
  const element = document.getElementById(`foundation-${id}`);
  element?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  element?.scrollIntoView({
    behavior: behavior ?? (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"),
    block: "start",
  });
}
