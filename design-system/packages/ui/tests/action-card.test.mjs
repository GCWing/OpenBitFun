import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionCard } from "../dist/index.js";

test("ActionCard keeps its native trigger and sibling actions independent", () => {
  const markup = renderToStaticMarkup(
    createElement(ActionCard, {
      actions: [
        { icon: createElement("svg"), id: "pin", label: "Pin" },
        { icon: createElement("svg"), id: "more", label: "More", "aria-haspopup": "menu", "aria-expanded": true, "aria-controls": "card-menu" },
      ],
      description: "Start a conversation",
      leading: createElement("svg", { "data-icon": "message" }),
      selected: true,
      size: "md",
    }, "New session"),
  );

  const triggerEnd = markup.indexOf("</button>");
  const siblingAction = markup.indexOf("<button", markup.indexOf("<button") + 1);

  assert.match(markup, /data-openbitfun-component="action-card"/);
  assert.match(markup, /data-selected="true"/);
  assert.match(markup, /data-size="md"/);
  assert.match(markup, /data-openbitfun-part="leading"/);
  assert.match(markup, /data-openbitfun-part="title"[^>]*data-overflow-behavior="marquee"[^>]*><span[^>]*>New session<\/span><\/span>/);
  assert.match(markup, /data-openbitfun-part="description"[^>]*data-overflow-behavior="marquee"[^>]*><span[^>]*>Start a conversation<\/span><\/span>/);
  assert.equal((markup.match(/<button/g) ?? []).length, 3);
  assert.ok(triggerEnd < siblingAction);
  assert.match(markup, /aria-controls="card-menu" aria-expanded="true" aria-haspopup="menu" aria-label="More"/);
  assert.doesNotMatch(markup, /data-openbitfun-variant="glass"/);
});

test("floating card actions share glass styling at the larger standard size without changing their independent state", () => {
  const markup = renderToStaticMarkup(createElement(ActionCard, {
    actionPlacement: "floating",
    actions: [
      { id: "launch", label: "Launch", tooltip: "Launching app", icon: createElement("svg"), loading: true },
      { id: "delete", label: "Delete", icon: createElement("svg"), tone: "danger" },
    ],
    description: "The full description remains beneath the floating actions.",
  }, "A long application title"));

  assert.match(markup, /data-action-placement="floating"/);
  assert.match(markup, /data-openbitfun-part="actions"/);
  assert.equal((markup.match(/<button\b/g) ?? []).length, 3);
  assert.equal((markup.match(/data-openbitfun-variant="glass"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-openbitfun-shape="circle"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-size="standard"/g) ?? []).length, 2);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /data-openbitfun-tone="danger"/);
  assert.match(markup, /The full description remains beneath the floating actions\./);
  assert.ok(markup.indexOf("</button>") < markup.lastIndexOf("<button"));
});

test("ActionCard disables its trigger and sibling actions as one contract", () => {
  const markup = renderToStaticMarkup(
    createElement(ActionCard, {
      actions: [{ icon: createElement("svg"), id: "more", label: "More" }],
      disabled: true,
    }, "Unavailable action"),
  );

  assert.match(markup, /data-disabled="true"/);
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 2);
});

test("ActionCard styles use public action-card and semantic tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--openbitfun-control-action-card-sm-min-block-size/);
  assert.match(styles, /--openbitfun-control-action-card-leading-size/);
  assert.match(styles, /--openbitfun-color-action-neutral-surface-hover/);
  assert.match(styles, /--openbitfun-color-selection-surface/);
  assert.match(styles, /--openbitfun-color-focus-ring/);
});
