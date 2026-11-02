import { version } from "react";

// React 19 treats `inert` as a boolean prop and ignores an empty string;
// React 18 only forwards the attribute when it is given a string.
const INERT_IS_BOOLEAN = Number.parseInt(version, 10) >= 19;

export type InertProps = { inert?: "" };

export function inertProps(isInert: boolean): InertProps {
  if (!isInert) return {};
  return { inert: (INERT_IS_BOOLEAN ? true : "") as "" };
}
