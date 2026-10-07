import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectTokenDefinitions,
  mergeTokenDocuments,
  resolveTokens,
} from "@openbitfun/token-engine";
import {
  referenceColorCatalog,
  referenceColorScales,
} from "../dist/authoring.js";
import {
  themeModes,
  themeTokenCatalog,
  themes,
} from "../dist/index.js";
import { resolveStatusColors } from "../scripts/resolve-status-colors.mjs";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

async function readSource(fileName) {
  return JSON.parse(
    await readFile(path.join(packageDirectory, "src", fileName), "utf8"),
  );
}

function channelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function parseColor(value, backdrop = [255, 255, 255]) {
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ];
  }
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(value);
  if (!rgba) throw new Error(`Unsupported test color: ${value}`);
  const alpha = Number(rgba[4]);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]
    .map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha));
}

function luminance(value, backdrop) {
  const channels = parseColor(value, backdrop).map(channelToLinear);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second, backdrop) {
  const lighter = Math.max(luminance(first, backdrop), luminance(second, backdrop));
  const darker = Math.min(luminance(first, backdrop), luminance(second, backdrop));
  return (lighter + 0.05) / (darker + 0.05);
}

test("reference colors expose ordered name-plus-number scales for authoring", () => {
  assert.deepEqual(Object.keys(referenceColorScales), [
    "neutral",
    "gray",
    "navy",
    "blue",
    "cyan",
    "purple",
    "pink",
    "green",
    "amber",
    "red",
  ]);
  assert.equal(
    referenceColorCatalog.length,
    Object.values(referenceColorScales).reduce((total, entries) => total + entries.length, 0),
  );

  for (const [scale, entries] of Object.entries(referenceColorScales)) {
    assert.ok(entries.length >= 11, `${scale} must expose a useful tonal range`);
    assert.deepEqual(
      entries.map((entry) => entry.step),
      entries.map((entry) => entry.step).toSorted((left, right) => left - right),
    );
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.name, `ref.color.${scale}.${entry.step}`);
      assert.match(entry.value, /^#[0-9a-f]{6}$/);
      assert.equal("cssVariable" in entry, false);
      if (index > 0) {
        assert.ok(
          luminance(entries[index - 1].value) >= luminance(entry.value),
          `${entry.name} must be no lighter than the previous step`,
        );
      }
    }
  }
});

test("reference colors retain the global-search action identity anchors", () => {
  const valueAt = (scale, step) => referenceColorScales[scale]
    .find((entry) => entry.step === step)?.value;

  assert.equal(valueAt("red", 650), "#ec221f");
  assert.equal(valueAt("amber", 550), "#ff8c00");
  assert.equal(valueAt("cyan", 500), "#059cb0");
  assert.equal(valueAt("blue", 575), "#3271d7");
  assert.equal(valueAt("purple", 450), "#9e54ff");
});

test("code-change semantics retain the requested addition and removal accents", () => {
  for (const mode of themeModes) {
    assert.equal(themes[mode]["color.codeChange.added"], "#1aa73e");
    assert.equal(themes[mode]["color.codeChange.removed"], "#ec221f");
  }
});

test("read-only diffs own reference colors without changing status semantics", () => {
  const light = themes.light;
  assert.equal(light["color.codeDiff.added.marker"], "#00cab1");
  assert.equal(light["color.codeDiff.removed.marker"], "#ff2e3f");
  assert.equal(light["color.codeDiff.added.line"], "#eaf9f5");
  assert.equal(light["color.codeDiff.removed.line"], "#ffeae6");
  assert.equal(light["color.codeDiff.added.word"], "#c7f2eb");
  assert.equal(light["color.codeDiff.removed.word"], "#ffcecd");
  assert.equal(light["color.codeDiff.syntax.keyword"], "#fc2b73");
  assert.equal(light["color.codeDiff.syntax.declaration"], "#c635e4");
  assert.equal(light["color.codeDiff.syntax.function"], "#7b43f8");
  for (const mode of themeModes) {
    const values = themes[mode];
    for (const side of ["added", "removed"]) {
      assert.notEqual(values[`color.codeDiff.${side}.marker`], values[`color.codeChange.${side}`]);
      assert.notEqual(values[`color.codeDiff.${side}.gutter`], values[`color.codeDiff.${side}.line`]);
      assert.notEqual(values[`color.codeDiff.${side}.word`], values[`color.codeDiff.${side}.line`]);
    }
  }
});

test("status families derive from the code-change and product emphasis anchors", async () => {
  for (const mode of themeModes) {
    const values = themes[mode];
    assert.equal(values["color.status.success.emphasis"], values["color.codeChange.added"]);
    assert.equal(values["color.status.danger.emphasis"], values["color.codeChange.removed"]);
    assert.equal(values["color.status.info.emphasis"], values["color.identity.harness.creative"]);
  }

  // Editing the canonical addition anchor must reach every derived status role.
  const source = mergeTokenDocuments(await readSource("reference.tokens.json"), await readSource("light.tokens.json"));
  source.color.codeChange.added.$value = "#123456";
  const updated = resolveStatusColors(resolveTokens(source));
  assert.equal(updated["color.status.success.emphasis"].value, "#123456");
  assert.equal(updated["color.status.success.content"].value, "#0c233a");
  assert.equal(updated["color.status.success.surface"].value, "rgba(18, 52, 86, 0.1)");
  assert.equal(updated["color.status.success.border"].value, "rgba(18, 52, 86, 0.3)");
  assert.equal(updated["color.status.success.content"].sourceValue, source.color.status.success.content.$value);
});

test("warning emphasis retains the product orange anchor in every theme", () => {
  for (const mode of themeModes) {
    assert.equal(themes[mode]["color.status.warning.emphasis"], "#ff8c00");
  }
});

test("semantic theme documents route solid colors through reference scales", async () => {
  for (const fileName of [
    "light.tokens.json",
    "dark.tokens.json",
    "high-contrast-light.tokens.json",
    "high-contrast-dark.tokens.json",
  ]) {
    const definitions = collectTokenDefinitions(await readSource(fileName));
    for (const [name, definition] of definitions) {
      if (definition.type === "color" && typeof definition.value === "string") {
        assert.equal(
          /^#[0-9a-f]{6}$/i.test(definition.value),
          false,
          `${fileName} token ${name} bypasses the reference palette`,
        );
      }
    }
  }
});

test("all theme variants expose the same semantic theme contract", async () => {
  const [reference, light, dark, highContrastLight, highContrastDark] = await Promise.all([
    readSource("reference.tokens.json"),
    readSource("light.tokens.json"),
    readSource("dark.tokens.json"),
    readSource("high-contrast-light.tokens.json"),
    readSource("high-contrast-dark.tokens.json"),
  ]);
  const variants = [
    resolveTokens(mergeTokenDocuments(reference, light)),
    resolveTokens(mergeTokenDocuments(reference, dark)),
    resolveTokens(mergeTokenDocuments(reference, light, highContrastLight)),
    resolveTokens(mergeTokenDocuments(reference, dark, highContrastDark)),
  ];
  const expectedNames = Object.keys(variants[0]).filter((name) => name.startsWith("color."));

  for (const variant of variants.slice(1)) {
    assert.deepEqual(
      Object.keys(variant).filter((name) => name.startsWith("color.")),
      expectedNames,
    );
  }
});

test("text, action, and field focus pairs meet their contrast requirements", () => {
  const variants = Object.entries(themes).map(([mode, values]) => [
    mode, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
  ]);

  for (const [mode, variant] of variants) {
    const backdrop = parseColor(variant["color.surface.canvas"].value);
    assert.ok(
      contrastRatio(
        variant["color.field.background"].value,
        variant["color.field.borderFocus"].value,
        backdrop,
      ) >= 3,
      `${mode} field focus contrast fell below 3:1`,
    );
    assert.ok(
      contrastRatio(
        variant["color.surface.canvas"].value,
        variant["color.content.primary"].value,
        backdrop,
      ) >= 4.5,
    );
    assert.ok(
      contrastRatio(
        variant["color.action.primary.background"].value,
        variant["color.action.primary.content"].value,
        backdrop,
      ) >= 4.5,
    );
    assert.ok(
      contrastRatio(
        variant["color.surface.panel"].value,
        variant["color.action.neutral.content"].value,
        backdrop,
      ) >= 4.5,
    );
    assert.ok(
      contrastRatio(
        variant["color.action.neutral.surface"].value,
        variant["color.action.neutral.content"].value,
        backdrop,
      ) >= 4.5,
    );
    assert.ok(
      contrastRatio(
        variant["color.control.highlight.background"].value,
        variant["color.control.highlight.content"].value,
        backdrop,
      ) >= 4.5,
      `${mode} control highlight contrast fell below 4.5:1`,
    );
    assert.equal(
      variant["color.content.requiredIndicator"].value,
      variant["color.control.highlight.background"].value,
      `${mode} required indicator must follow the shared highlight`,
    );
    for (const status of ["info", "success", "warning", "danger"]) {
      const minimumContrast = 4.5;
      assert.ok(
        contrastRatio(
          variant[`color.status.${status}.surface`].value,
          variant[`color.status.${status}.content`].value,
          backdrop,
        ) >= minimumContrast,
        `${mode} ${status} contrast fell below ${minimumContrast}:1`,
      );
    }
  }
});

test("Button states have a mode-complete palette independent from shared actions", () => {
  const light = themes.light;
  assert.equal(light["component.button.outlineBorder"], "rgba(0, 0, 0, 0.08)");
  assert.equal(
    light["component.button.outlineBorderInteractive"],
    light["component.button.outlineBorder"],
  );
  for (const suffix of ["", "Hover", "Pressed"]) {
    assert.equal(light[`component.button.fillBackground${suffix}`], "rgba(0, 0, 0, 0.08)");
  }
  assert.equal(light["component.button.primaryBackground"], "rgba(0, 0, 0, 0.80)");
  assert.equal(light["component.button.primaryBackgroundHover"], "rgba(0, 0, 0, 0.60)");
  assert.equal(light["component.button.primaryBackgroundPressed"], "rgba(0, 0, 0, 0.90)");
  assert.equal(light["component.button.primaryContentDisabled"], "rgba(0, 0, 0, 0.20)");
  assert.equal(light["component.button.textContent"], "#059cb0");
  assert.equal(light["component.button.textContentDisabled"], "rgba(5, 156, 176, 0.30)");
  const names = Object.keys(light).filter(name => name.startsWith("component.button."));
  for (const [mode, values] of Object.entries(themes)) {
    assert.deepEqual(Object.keys(values).filter(name => name.startsWith("component.button.")), names);
    if (mode === "light") continue;
    assert.equal(values["component.button.primaryBackground"], values["color.action.primary.background"]);
    assert.equal(values["component.button.outlineBorderInteractive"], values["color.action.neutral.border"]);
    assert.equal(values["component.button.fillBackgroundPressed"], values["color.action.neutral.surfacePressed"]);
  }
});

test("Empty artwork uses a mode-complete opaque component color", () => {
  assert.equal(themes.light["component.empty.media"], "color-mix(in srgb, #6a6a6a 35%, #f7f7f7)");
  assert.equal(themes.dark["component.empty.media"], "color-mix(in srgb, #858585 35%, #0e0e10)");
  for (const values of Object.values(themes)) {
    assert.match(values["component.empty.media"], /^color-mix\(in srgb, #[0-9a-f]{6} 35%, #[0-9a-f]{6}\)$/i);
  }
});

test("default modes preserve the built-in Appearance anchor values", () => {
  assert.equal(themes.light["color.surface.canvas"], "#fdfdfd");
  assert.equal(themes.light["color.content.primary"], "rgba(0, 0, 0, 0.80)");
  assert.equal(themes.light["color.content.secondary"], "rgba(0, 0, 0, 0.60)");
  assert.equal(themes.light["color.content.disabled"], "rgba(0, 0, 0, 0.30)");
  assert.equal(themes.light["color.action.primary.background"], "#101a27");
  assert.equal(themes.light["color.action.neutral.border"], "rgba(0, 0, 0, 0.05)");
  assert.equal(themes.light["color.action.neutral.content"], "rgba(0, 0, 0, 0.80)");
  assert.equal(themes.light["color.action.neutral.contentDisabled"], "rgba(0, 0, 0, 0.30)");
  assert.equal(themes.light["color.action.secondary.content"], "rgba(0, 0, 0, 0.80)");
  assert.equal(themes.light["color.action.quiet.content"], "rgba(0, 0, 0, 0.60)");
  assert.equal(themes.light["color.action.neutral.surface"], "rgba(0, 0, 0, 0.05)");
  assert.equal(themes.light["color.action.neutral.surfaceHover"], "rgba(0, 0, 0, 0.08)");
  assert.equal(themes.light["color.action.neutral.surfacePressed"], "rgba(0, 0, 0, 0.10)");
  assert.equal(themes.light["color.selection.surface"], "rgba(0, 0, 0, 0.08)");
  assert.equal(themes.light["color.surface.chrome"], "#f8f8f9");
  assert.equal(themes.light["color.surface.tertiary"], "#f7f7f7");
  assert.equal(themes.light["color.scrollbar.thumb"], "rgba(0, 0, 0, 0.20)");
  assert.equal(themes.light["color.scrollbar.thumbHover"], "rgba(0, 0, 0, 0.30)");
  assert.equal(themes.light["color.keyHint.background"], "rgba(0, 0, 0, 0.08)");
  assert.equal(themes.light["color.control.highlight.background"], "#059cb0");
  assert.equal(themes.light["color.control.highlight.content"], "#000000");
  assert.equal(themes.light["color.content.requiredIndicator"], "#059cb0");
  assert.equal(themes.light["color.control.launcher.background"], "rgba(0, 0, 0, 0.08)");
  assert.equal(
    themes.light["color.control.launcher.backgroundHover"],
    "color-mix(in srgb, #059cb0 20%, transparent)",
  );
  assert.equal(
    themes.light["color.control.launcher.backgroundPressed"],
    "color-mix(in srgb, #059cb0 30%, transparent)",
  );
  assert.equal(themes.light["color.control.launcher.content"], "rgba(0, 0, 0, 0.80)");
  assert.equal(themes.light["color.control.launcher.contentHover"], "#059cb0");
  assert.equal(themes.light["color.control.launcher.contentPressed"], "#059cb0");
  assert.equal(themes.light["color.control.switch.track"], "rgba(0, 0, 0, 0.10)");
  assert.equal(themes.light["color.control.switch.trackChecked"], "#059cb0");
  assert.equal(themes.light["color.control.switch.thumb"], "#ffffff");
  assert.equal(themes.light["color.identity.harness.minimal"], "#b434ef");
  assert.equal(themes.light["color.identity.harness.standard"], "#1aa73e");
  assert.equal(themes.light["color.identity.harness.ultimate"], "#ff8c00");
  assert.equal(themes.light["color.identity.harness.creative"], "#2e7eff");
  assert.equal(themes.light["color.identity.globalSearch.newSession"], "#ec221f");
  assert.equal(themes.light["color.identity.globalSearch.openBrowser"], "#ff8c00");
  assert.equal(themes.light["color.identity.globalSearch.openTerminal"], "rgba(0, 0, 0, 0.80)");
  assert.equal(themes.light["color.identity.globalSearch.openProject"], "#059cb0");
  assert.equal(themes.light["color.identity.globalSearch.newProject"], "#3271d7");
  assert.equal(themes.light["color.identity.globalSearch.openFiles"], "#9e54ff");
  assert.equal(themes.light["color.status.warning.surface"], "rgba(255, 140, 0, 0.1)");
  assert.equal(themes.light["shadow.base"], "0 4px 8px rgba(16, 26, 39, 0.07)");
  assert.equal(themes.light["shadow.composer"], "0 2px 12px rgba(0, 0, 0, 0.08)");
  assert.equal(themes.light["shadow.menu"], "0 4px 20px rgba(0, 0, 0, 0.12)");
  assert.equal(themes.light["shadow.overlay"], "0 4px 20px rgba(0, 0, 0, 0.12)");
  assert.equal(themes.light["opacity.disabled"], 0.55);
  assert.equal(themes.dark["color.surface.canvas"], "#0e0e10");
  assert.equal(themes.dark["color.content.primary"], "#e8e8e8");
  assert.equal(themes.dark["color.keyHint.background"], "rgba(255, 255, 255, 0.1)");
  assert.equal(themes.dark["color.action.primary.background"], "rgba(255, 255, 255, 0.16)");
  assert.equal(themes.dark["color.action.neutral.surface"], "rgba(255, 255, 255, 0.1)");
  assert.equal(themes.dark["color.control.highlight.background"], "#059cb0");
  assert.equal(themes.dark["color.control.highlight.content"], "#000000");
  assert.equal(themes.dark["color.content.requiredIndicator"], "#059cb0");
  assert.equal(themes.dark["color.control.launcher.background"], "rgba(255, 255, 255, 0.15)");
  assert.equal(
    themes.dark["color.control.launcher.backgroundHover"],
    "color-mix(in srgb, #059cb0 20%, transparent)",
  );
  assert.equal(
    themes.dark["color.control.launcher.backgroundPressed"],
    "color-mix(in srgb, #059cb0 30%, transparent)",
  );
  assert.equal(themes.dark["color.control.launcher.contentHover"], "#059cb0");
  assert.equal(themes.dark["color.control.launcher.contentPressed"], "#059cb0");
  assert.equal(themes.dark["color.control.switch.trackChecked"], "#059cb0");
  assert.equal(themes.dark["color.identity.harness.minimal"], "#b434ef");
  assert.equal(themes.dark["color.identity.harness.standard"], "#1aa73e");
  assert.equal(themes.dark["color.identity.harness.ultimate"], "#ff8c00");
  assert.equal(themes.dark["color.identity.harness.creative"], "#2e7eff");
  assert.equal(themes.dark["color.identity.globalSearch.newSession"], "#ec221f");
  assert.equal(themes.dark["color.identity.globalSearch.openBrowser"], "#ff8c00");
  assert.equal(themes.dark["color.identity.globalSearch.openTerminal"], "#b0b0b0");
  assert.equal(themes.dark["color.identity.globalSearch.openProject"], "#059cb0");
  assert.equal(themes.dark["color.identity.globalSearch.newProject"], "#3271d7");
  assert.equal(themes.dark["color.identity.globalSearch.openFiles"], "#9e54ff");
  assert.equal(themes.dark["color.scrollbar.thumb"], "rgba(255, 255, 255, 0.20)");
  assert.equal(themes.dark["color.scrollbar.thumbHover"], "rgba(255, 255, 255, 0.30)");
  assert.equal(themes.dark["shadow.base"], "0 4px 8px rgba(0, 0, 0, 0.7)");
  assert.equal(themes.dark["shadow.composer"], "0 2px 6px rgba(0, 0, 0, 0.32)");
  assert.equal(themes.dark["shadow.menu"], "0 4px 10px rgba(0, 0, 0, 0.48)");
  assert.equal(themes.dark["shadow.overlay"], "0 4px 20px rgba(0, 0, 0, 0.48)");
  assert.equal(themes.dark["opacity.disabled"], 0.6);
});

test("public theme catalog contains only semantic theme tokens for every mode", () => {
  assert.deepEqual(themeModes, [
    "light",
    "dark",
    "highContrastLight",
    "highContrastDark",
  ]);
  assert.equal(themeTokenCatalog.length, Object.keys(themes.light).length);
  for (const token of themeTokenCatalog) {
    assert.equal(
      ["color.", "component.button.", "component.empty.", "effect.", "opacity.", "shadow."].some((prefix) => token.name.startsWith(prefix)),
      true,
    );
    assert.equal(token.name.startsWith("ref."), false);
    if (
      token.name.startsWith("color.")
      || token.name.startsWith("component.button.")
      || token.name.startsWith("component.empty.")
    ) {
      assert.equal(token.type, "color");
    }
    assert.deepEqual(Object.keys(token.values), themeModes);
  }
});
