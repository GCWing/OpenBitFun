// Cross-platform contract, enforced instead of described.
//
// The design system ships one visual language per surface (web today, mobile today, tablet and
// watch later) and a shared token layer underneath. Two things must therefore stay true as the
// surfaces multiply:
//
//   1. Vocabulary — one word per idea. A platform may skip a state it cannot express on its
//      input model (a touch device has no hover), but it may not rename the idea. `off/on` and
//      `checked`, or `focus-visible` and `focus-within` on the same element, are the drift this
//      test exists to stop.
//   2. Platform — a surface is declared, never implied by the component name. `category` says
//      what a component is; `platforms` says where it runs, so a third surface never renames an
//      existing entry.
//
// Divergence that is deliberate is listed in the registers below with a reason, so the next
// reader can tell a decision from an accident.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { componentPlatforms, componentRegistry } from "../dist/registry.js";

const KNOWN_PLATFORMS = ["web", "mobile", "tablet", "desktop", "watch"];

/* States that describe how a control behaves, not what it contains. Content variants ("with-title",
   "media", "artwork") stay free-form. */
const INTERACTION_STATES = new Set([
  "active", "checked", "collapsed", "disabled", "expanded", "focus-visible", "focus-within", "hover",
  "indeterminate", "invalid", "loading", "off", "on", "open", "pressed", "read-only", "selected",
  "unselected",
]);

/* Pairs that name the same idea and must not both appear on one component's counterpart pair. */
const SYNONYM_PAIRS = [
  ["checked", "on"],
  ["checked", "off"],
  ["selected", "checked"],
];

/* Register 1 — a web interaction state a mobile counterpart does not declare.
   Reason is required: platform anatomy is allowed to excuse a state, silence is not. */
const MOBILE_STATE_GAPS = {
  MobileButton: "web Button declares no interaction state for the press ring the touch surface draws itself",
  MobileComposer: "the mobile composer is an expandable shell whose validation lives in the sheet, not in the row",
  MobileTextarea: "touch text fields draw focus on the wrapper and never show hover",
  MobileSelect: "the mobile select has no hover on touch; its field is a button, so pressed feedback replaces it",
};

/* Register 2 — a shared axis the two surfaces express differently: either the same name with a
   second meaning, or an axis only one surface has. */
const PROP_PARITY_GAPS = {
  Checkbox: "appearance means the control skin (custom|native); the mobile row uses the same name for its container surface",
  IconButton: "the mobile button exposes selected and writes aria-pressed itself; the web button is stateless and leaves the toggle to the caller",
};

async function source(relative) {
  return readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");
}

/* Compound entries (Sheet lives with Dialog) have no file of their own. */
async function optionalSource(relative) {
  try {
    return await source(relative);
  } catch {
    return "";
  }
}

function propsOf(tsx) {
  /* Interfaces are written both multiline and inline, so read to the closing brace at depth zero
     instead of assuming a line break before it. */
  const start = tsx.search(/export interface \w+Props/);
  if (start < 0) return [];
  const body = tsx.slice(tsx.indexOf("{", start) + 1);
  let depth = 0;
  let end = body.length;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "{" || char === "<") depth += 1;
    else if (char === ">" || char === "}") {
      if (char === "}" && depth === 0) { end = index; break; }
      depth -= 1;
    }
  }
  const members = body.slice(0, end);
  return [...new Set([...members.matchAll(/(?:^|[,;{\s])([A-Za-z][A-Za-z0-9]*)\??:/g)].map(match => match[1]))];
}

test("every component declares the surfaces it is authored for", () => {
  for (const component of componentRegistry) {
    const platforms = componentPlatforms(component);
    assert.ok(platforms.length > 0, `${component.name} declares no platform`);
    for (const platform of platforms) {
      assert.ok(KNOWN_PLATFORMS.includes(platform), `${component.name} declares unknown platform ${platform}`);
    }
  }
  assert.ok(componentPlatforms({ category: "mobile" }).includes("mobile"));
  assert.ok(componentPlatforms({ category: "form", platforms: ["web", "mobile"] }).includes("mobile"));
});

test("both surfaces keep one word per interaction state", async () => {
  const mobileEntry = await source("mobile.ts");
  const names = [...mobileEntry.matchAll(/^\s*(Mobile[A-Za-z]+),$/gm)].map(match => match[1]);
  assert.ok(names.length > 0);

  for (const name of names) {
    const mobile = componentRegistry.find(component => component.name === name);
    assert.ok(mobile, `${name} is exported but not registered`);

    for (const state of mobile.states) {
      if (!INTERACTION_STATES.has(state)) continue;
      const counterpart = SYNONYM_PAIRS.find(pair => pair.includes(state));
      if (!counterpart) continue;
      const web = componentRegistry.find(component => component.name === name.replace(/^Mobile/, ""));
      if (!web) continue;
      assert.ok(
        !counterpart.every(word => mobile.states.includes(word) || web.states.includes(word)),
        `${name} and ${web.name} name one interaction twice: ${counterpart.join(" / ")}`,
      );
    }
  }
});

test("a web interaction state reaches its mobile counterpart or is registered as a gap", async () => {
  const mobileEntry = await source("mobile.ts");
  const names = [...mobileEntry.matchAll(/^\s*(Mobile[A-Za-z]+),$/gm)].map(match => match[1]);

  for (const name of names) {
    const web = componentRegistry.find(component => component.name === name.replace(/^Mobile/, ""));
    const mobile = componentRegistry.find(component => component.name === name);
    if (!web || !mobile) continue;

    const missing = web.states.filter((state) => {
      if (!INTERACTION_STATES.has(state)) return false;
      if (mobile.states.includes(state)) return false;
      /* A wrapper that draws the focus ring reports focus-within; the input inside still gets
         focus-visible from the browser, so the pair names the same moment on different elements. */
      if (state === "focus-visible" && mobile.states.includes("focus-within")) return false;
      /* Selection words differ per control family by design: a switch has off/on, a tab has
         selected, a checkbox has checked. */
      if (["off", "on"].includes(state)) return false;
      return true;
    });

    if (missing.length === 0) continue;
    assert.ok(
      MOBILE_STATE_GAPS[name],
      `${name} is missing ${missing.join(", ")} from ${web.name}: add the state or register the gap`,
    );
  }
});

test("a shared prop name keeps one meaning across surfaces", async () => {
  const mobileEntry = await source("mobile.ts");
  const names = [...mobileEntry.matchAll(/^\s*(Mobile[A-Za-z]+),$/gm)].map(match => match[1]);
  /* Native attributes (`disabled`) are shared by construction, so only the system axes are read. */
  const shared = ["value", "checked", "selected", "onValueChange", "onCheckedChange", "size", "tone", "variant", "appearance", "invalid"];

  for (const name of names) {
    const web = componentRegistry.find(component => component.name === name.replace(/^Mobile/, ""));
    if (!web || PROP_PARITY_GAPS[web.name]) continue;
    const [webSource, mobileSource] = await Promise.all([
      optionalSource(`components/${web.name}/${web.name}.tsx`),
      source(`mobile/${name}/${name}.tsx`),
    ]);
    const webProps = new Set([...propsOf(webSource), ...web.props.map(prop => prop.name)]);
    const mobileProps = propsOf(mobileSource);
    assert.ok(mobileProps.length > 0, `${name} exposes no props`);
    for (const prop of shared) {
      if (!mobileProps.includes(prop)) continue;
      assert.ok(
        webProps.has(prop) || prop === "appearance",
        `${name}.${prop} has no counterpart on ${web.name}: name the axis both surfaces know`,
      );
    }
  }
});

test("mobile components reuse the shared token layer instead of private colour", async () => {
  const mobileEntry = await source("mobile.ts");
  const names = [...mobileEntry.matchAll(/^\s*(Mobile[A-Za-z]+),$/gm)].map(match => match[1]);

  for (const name of names) {
    const styles = await source(`mobile/${name}/${name}.module.css`);
    assert.match(styles, /@layer openbitfun\.components/, `${name} styles must stay in the shared layer`);
    assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i, `${name} must not hardcode a colour`);
    assert.doesNotMatch(styles, /rgba?\(/, `${name} must not hardcode a colour`);
    for (const match of styles.matchAll(/var\((--openbitfun-[a-z0-9-]+)/g)) {
      assert.match(match[1], /^--openbitfun-/, `${name} uses a non-token custom property`);
    }
  }
});
