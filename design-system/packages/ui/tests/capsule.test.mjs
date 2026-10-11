import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Button, Capsule, Icon, IconButton, MultiSelect, TabGroup, Tooltip } from "../dist/index.js";

const action = (props = {}) => h(IconButton, {
  "aria-label": "Remove provider", icon: h(Icon, { name: "delete" }), ...props,
});

test("a tooltip-wrapped capsule action keeps its accessible name and destructive state with shared glass presentation", () => {
  const markup = renderToStaticMarkup(h(Capsule, {
    size: "sm",
    action: h(Tooltip, { content: "Remove provider" }, action({ tone: "danger", variant: "fill", loading: true })),
  }, h(Button, { size: "sm", "aria-label": "Edit provider" }, "Long provider name")));
  assert.match(markup, /data-openbitfun-component="capsule"/);
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

test("capsules without actions preserve ordinary content and do not add a focus target", () => {
  const markup = renderToStaticMarkup(h(Capsule, { size: "xs" }, "A tag"));
  assert.match(markup, />A tag<\/span>/);
  assert.doesNotMatch(markup, /tabindex|role=|data-openbitfun-part="action"/);
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
