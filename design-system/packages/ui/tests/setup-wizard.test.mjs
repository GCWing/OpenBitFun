import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, SetupWizard } from "../dist/index.js";

test("SetupWizard publishes localized guidance and one current-step indicator without an overlay", () => {
  const markup = renderToStaticMarkup(createElement(SetupWizard, {
    title: "Configure workflow", titleId: "workflow-title", guideLabel: "Setup guidance",
    step: { id: "rules", title: "Keep results consistent", description: "Rules apply to every run.", label: "Working rules", progress: "2 of 5" },
    headerActions: createElement(Button, null, "Close"),
    footer: createElement(Button, { form: "workflow-form", type: "submit" }, "Continue"),
  }, createElement("form", { id: "workflow-form" })));
  assert.match(markup, /id="workflow-title"/);
  assert.match(markup, /aria-label="Setup guidance"/);
  assert.match(markup, /aria-live="polite" aria-atomic="true"/);
  assert.equal((markup.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(markup, /2 of 5/);
  assert.match(markup, /Rules apply to every run\./);
  assert.match(markup, /form="workflow-form"/);
  assert.doesNotMatch(markup, /role="(?:dialog|tablist|tab)"/);
});

test("SetupWizard contains editor content without requiring three stages or navigation callbacks", () => {
  const markup = renderToStaticMarkup(createElement(SetupWizard, {
    title: "Rules", guideLabel: "Guidance", contentMode: "contained",
    step: { id: "only", title: "Shared defaults", description: "Applied to future runs.", label: "Rules", progress: "1 / 1" },
    footer: createElement(Button, null, "Save"),
  }, createElement("textarea", { defaultValue: "Keep this draft" })));
  assert.match(markup, /data-content-mode="contained"/);
  assert.match(markup, /<textarea>Keep this draft<\/textarea>/);
  assert.match(markup, /1 \/ 1/);
});
