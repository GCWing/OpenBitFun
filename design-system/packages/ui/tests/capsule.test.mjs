import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Button, Capsule, Icon, IconButton, MultiSelect, Select, TabGroup, Tooltip } from "../dist/index.js";

const action = (props = {}) => h(IconButton, {
  "aria-label": "Remove provider", icon: h(Icon, { name: "delete" }), ...props,
});

for (const actionPlacement of ["overlay", "reserved"]) {
  test(`a tooltip-wrapped ${actionPlacement} capsule action keeps its accessible name and destructive state with shared glass presentation`, () => {
    const markup = renderToStaticMarkup(h(Capsule, {
      size: "sm",
      actionPlacement,
      action: h(Tooltip, { content: "Remove provider" }, action({ tone: "danger", variant: "fill", loading: true })),
    }, h(Button, { size: "sm", "aria-label": "Edit provider" }, "Long provider name")));
    assert.match(markup, /data-openbitfun-component="capsule"/);
    assert.ok(markup.includes(`data-action-placement="${actionPlacement}"`));
    assert.match(markup, /data-openbitfun-part="action"/);
    assert.match(markup, /data-openbitfun-variant="glass"/);
    assert.match(markup, /data-openbitfun-shape="circle"/);
    assert.match(markup, /data-openbitfun-tone="danger"/);
    assert.match(markup, /aria-label="Remove provider"/);
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /Long provider name/);
    assert.equal((markup.match(/<button\b/g) ?? []).length, 2);
    assert.ok(markup.indexOf("</button>") < markup.lastIndexOf("<button"), "Primary and secondary actions must be siblings");
  });
}

test("capsules without actions preserve ordinary content and do not add a focus target", () => {
  const markup = renderToStaticMarkup(h(Capsule, { size: "xs", actionPlacement: "reserved" }, "A tag"));
  assert.match(markup, />A tag<\/span>/);
  assert.doesNotMatch(markup, /tabindex|role=|data-openbitfun-part="action"|data-action-placement/);
});

test("split capsules align filled edges with equal or compact content-sized widths", async () => {
  const markup = renderToStaticMarkup(h(Capsule, { layout: "split", splitSizing: "content", size: "sm", role: "group", "aria-label": "Provider" },
    h(Select, { size: "sm", variant: "pill", width: "content", "aria-label": "Region", options: [{ value: "international", label: "International" }] }),
    h(Button, { size: "sm", variant: "primary" }, "Sign in"),
  ));
  assert.match(markup, /data-layout="split"/);
  assert.match(markup, /data-split-sizing="content"/);
  assert.match(renderToStaticMarkup(h(Capsule, { layout: "split" })), /data-split-sizing="equal"/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-label="Region"/);
  assert.match(markup, /Sign in/);
  assert.equal((markup.match(/<button\b/g) ?? []).length, 2);
  assert.ok(markup.indexOf("</button>") < markup.lastIndexOf("<button"));
  assert.doesNotMatch(markup, /data-openbitfun-part="action"/);

  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  const splitRules = styles.match(/\[data-layout=split\][^{}]*\{[^}]*\}/g)?.join("\n") ?? "";
  assert.match(splitRules, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(splitRules, /\[data-split-sizing=content\]\{grid-template-columns:repeat\(2,max-content\);inline-size:max-content/);
  assert.match(splitRules, /\[data-split-sizing=content\]>\[data-openbitfun-component=button\]\{inline-size:max-content;max-inline-size:100%/);
  assert.match(splitRules, /\[data-openbitfun-component=select\]>\[data-openbitfun-part=trigger\]\{border-color:transparent;background-clip:padding-box\}/);
  assert.match(splitRules, /border-inline-end-width:0/);
  assert.match(splitRules, /border-inline-start-width:0/);
  assert.match(splitRules, /border-start-end-radius:0;border-end-end-radius:0/);
  assert.match(splitRules, /border-start-start-radius:0;border-end-start-radius:0/);
});

test("tab actions and removable MultiSelect labels adopt the same glass presentation", () => {
  const tabs = renderToStaticMarkup(h(TabGroup, { items: [{ value: "a", label: "A long tab", endAction: action({ variant: "outline" }) }] }));
  assert.match(tabs, /data-openbitfun-variant="glass"/);
  assert.match(tabs, /role="tab"/);
  assert.match(tabs, /A long tab/);

  const select = renderToStaticMarkup(h(MultiSelect, {
    "aria-label": "Tags", value: ["a"], options: [{ value: "a", label: "A long tag" }], disabled: true,
  }));
  assert.match(select, /data-openbitfun-component="capsule"/);
  assert.match(select, /data-openbitfun-variant="glass"/);
  assert.match(select, /A long tag/);
  assert.match(select, /disabled=""/);
});

test("a standalone icon retains its chosen variant outside a floating action slot", () => {
  const markup = renderToStaticMarkup(action({ variant: "outline" }));
  assert.match(markup, /data-openbitfun-variant="outline"/);
  assert.doesNotMatch(markup, /data-openbitfun-variant="glass"/);
});
