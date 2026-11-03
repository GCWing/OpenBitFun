import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { LoadingState, Spinner } from "../dist/index.js";
import { FlowChatRuntimeStatus } from "../dist/flow-chat.js";

test("Spinner exposes the logo by default and retains the bar presentation", () => {
  const logo = renderToStaticMarkup(createElement(Spinner, { size: "sm" }));
  const bars = renderToStaticMarkup(createElement(Spinner, {
    "aria-label": "Loading",
    variant: "bars",
  }));

  assert.match(logo, /data-openbitfun-component="spinner"/);
  assert.match(logo, /data-variant="logo"/);
  assert.match(logo, /data-size="sm"/);
  assert.equal((logo.match(/<span/g) ?? []).length, 3);
  assert.match(logo, /aria-hidden="true"/);
  assert.match(bars, /role="status"/);
  assert.match(bars, /aria-label="Loading"/);
  assert.equal((bars.match(/class=/g) ?? []).length, 4);
});

test("legacy matrix callers receive the same logo and preserve accessible props", () => {
  const props = { "aria-label": "Loading", size: "xs", active: false, "data-testid": "pending" };
  const logo = renderToStaticMarkup(createElement(Spinner, props));
  assert.equal(renderToStaticMarkup(createElement(Spinner, { ...props, variant: "matrix" })), logo);
  assert.match(logo, /data-active="false"/);
  assert.match(logo, /role="status"/);
  assert.match(logo, /data-testid="pending"/);
});

test("FlowChat runtime status gives the logo a text-readable medium allocation", () => {
  const markup = renderToStaticMarkup(createElement(FlowChatRuntimeStatus, {
    label: "Working", visible: true,
  }));
  assert.match(markup, /data-openbitfun-component="spinner"[^>]+data-size="md"[^>]+data-variant="logo"/);
  assert.doesNotMatch(markup, /data-variant="matrix"/);
});

test("LoadingState composes Spinner with optional support copy", () => {
  const markup = renderToStaticMarkup(createElement(LoadingState, null, "Loading project"));
  assert.match(markup, /data-openbitfun-component="loading-state"/);
  assert.match(markup, /data-openbitfun-component="spinner"/);
  assert.match(markup, /data-openbitfun-part="label">Loading project/);
});

test("Spinner styling uses public system, motion, and semantic tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  assert.match(styles, /--openbitfun-layout-spinner-matrix-cell-md/);
  assert.match(styles, /--openbitfun-layout-spinner-matrix-gap-md/);
  assert.match(styles, /--openbitfun-motion-duration-loop/);
  assert.match(styles, /--openbitfun-color-content-muted/);
  assert.doesNotMatch(styles, /openbitfun-spinner-matrix-pulse/);
  assert.match(styles, /prefers-reduced-motion/);
});

test("logo motion keeps a continuous coupled cycle with a fixed double-hexagon silhouette", async () => {
  const source = await readFile(new URL("../src/components/Spinner/spinnerMotion.ts", import.meta.url), "utf8");
  const module = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { createSpinnerAnimations } = await import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
  let frames;
  let timing;
  const animation = {};
  const result = createSpinnerAnimations({ animate(keyframes, options) {
    frames = keyframes;
    timing = options;
    return animation;
  } });
  assert.deepEqual(result, [animation]);
  assert.deepEqual(timing, { duration: 1800, iterations: Infinity, easing: "linear" });
  const first = frames[0];
  const last = frames.at(-1);
  const rotation = frame => Number(frame.transform.match(/rotate\(([^d]+)deg\)/)[1]);
  const scale = frame => Number(frame.transform.match(/scale\(([^)]+)\)/)[1]);
  assert.equal(first.offset, 0);
  assert.equal(last.offset, 1);
  assert.ok(Math.abs(rotation(last) - rotation(first) - 60) < 1e-10);
  assert.ok(Math.abs(scale(last) - scale(first)) < 1e-10);
  assert.equal(last.opacity, first.opacity);
  assert.equal(first.filter, last.filter);
  assert.ok(Math.min(...frames.map(frame => frame.opacity)) < 0.35);
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(rotation(frames[index]) > rotation(frames[index - 1]), "rotation continues through the clear phase");
    assert.ok(scale(frames[index]) >= 0.974 && scale(frames[index]) <= 1.026);
  }
  const mark = await readFile(new URL("../src/brand/assets/openbitfun-loading-mark.svg", import.meta.url), "utf8");
  assert.equal((mark.match(/<path\b/g) ?? []).length, 1);
  assert.match(mark, /fill-rule="evenodd"/);
  assert.equal((mark.match(/M/g) ?? []).length, 2, "both contours share the same transformed artwork");
});
