import type { ComponentMeta } from "../registry.types";

export const subagentHatchMeta = {
  category: "brand",
  name: "SubagentHatch",
  description: "An antenna-topped egg that incubates during delegation and opens once into the supplied Subagent avatar.",
  maturity: "stable",
  props: [
    { name: "phase", type: "'incubating' | 'ready' | 'stopped'" },
    { name: "size", type: "number", defaultValue: "space.8" },
    { name: "active", type: "boolean", defaultValue: "true" },
    { name: "children", type: "ReactNode" },
    { name: "label", type: "string" },
  ],
  states: ["incubating", "ready", "stopped", "reduced-motion"],
  tokens: ["space.8"],
} as const satisfies ComponentMeta;

export const openBitFunSolidMarkMeta = {
  category: "brand",
  name: "OpenBitFunSolidMark",
  description: "The original silver OpenBitFun mark on a transparent canvas, preserving its material and shading.",
  maturity: "stable",
  props: [
    { name: "size", type: "number", defaultValue: "control.height.lg" },
    { name: "label", type: "string" },
  ],
  states: ["default"],
  tokens: ["control.height.lg"],
} as const satisfies ComponentMeta;

export const openBitFunAppIconMeta = {
  category: "brand",
  name: "OpenBitFunAppIcon",
  description: "The installed application icon: the silver mark on its authored black rounded-square tile, with resolution-aware assets.",
  maturity: "stable",
  props: [
    { name: "size", type: "number", defaultValue: "control.height.lg" },
    { name: "label", type: "string" },
  ],
  states: ["default"],
  tokens: ["control.height.lg"],
} as const satisfies ComponentMeta;

export const openBitFunMarkMeta = {
  category: "brand",
  name: "OpenBitFunMark",
  description: "The authored OpenBitFun mark with inherited color and an optional startup breathing motion.",
  maturity: "stable",
  props: [
    { name: "size", type: "CSSProperties['width']", defaultValue: "120px" },
    { name: "label", type: "string" },
    { name: "motion", type: "'none' | 'breathe'", defaultValue: "none" },
    { name: "active", type: "boolean", defaultValue: "true" },
  ],
  states: ["static", "breathe", "paused"],
  tokens: ["color.content.primary"],
} as const satisfies ComponentMeta;

export const openBitFunBrandMotionMeta = {
  category: "brand",
  name: "OpenBitFunBrandMotion",
  description: "OpenBitFun motion: circulating highlights, counter-rotating hexagons, or a compact engineering drawing that forms the original mark.",
  maturity: "stable",
  props: [
    { name: "size", type: "number", defaultValue: "192" },
    { name: "label", type: "string" },
    { name: "variant", type: "'flow' | 'counter-rotate' | 'construction'", defaultValue: "flow" },
    { name: "active", type: "boolean", defaultValue: "true" },
  ],
  states: ["construction", "playing", "counter-rotate", "paused", "reduced-motion"],
  tokens: ["color.content.primary"],
} as const satisfies ComponentMeta;
