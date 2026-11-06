import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChatComposer,
  ChatComposerActionButton,
  ChatComposerContent,
  ChatComposerEndActions,
  ChatComposerQueue,
  ChatComposerQueueAttachmentBadge,
  ChatComposerQueueHeader,
  ChatComposerQueueItem,
  ChatComposerQueueItemActions,
  ChatComposerQueueItemContent,
  ChatComposerQueueItemMessage,
  ChatComposerQueueItemStatus,
  ChatComposerQueueList,
  ChatComposerQueueTitle,
  ChatComposerQueueToggle,
  ChatComposerStartActions,
} from "../dist/flow-chat.js";

test("ChatComposerActionButton shares one stable action and icon geometry", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(ChatComposerActionButton, {
        "aria-expanded": true,
        "aria-label": "Add context",
        icon: createElement("svg", { "data-icon": "plus" }),
        variant: "fill",
      }),
      createElement(ChatComposerActionButton, {
        "aria-label": "Send",
        icon: createElement("svg", { "data-icon": "arrow-up" }),
        variant: "primary",
      }),
    ),
  );

  assert.equal((markup.match(/data-openbitfun-role="composer-action"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-openbitfun-shape="circle"/g) ?? []).length, 2);
  assert.match(markup, /data-openbitfun-variant="fill"/);
  assert.match(markup, /data-openbitfun-variant="primary"/);
});

test("ChatComposer publishes stable context, content, and action slots", () => {
  const markup = renderToStaticMarkup(
    createElement(ChatComposer, {
      contextBar: createElement("div", null, "This computer · OpenBitFun"),
      endActions: createElement("button", { type: "button" }, "Send"),
      layout: "compact",
      startActions: createElement("button", { type: "button" }, "Add"),
      children: createElement("textarea", { "aria-label": "Message" }),
    }),
  );

  assert.match(markup, /data-openbitfun-component="chat-composer"/);
  assert.match(markup, /data-has-context="true"/);
  assert.match(markup, /data-openbitfun-part="contextBar"/);
  const surface = markup.match(/<div[^>]+data-openbitfun-part="surface"[^>]*>/)?.[0];
  assert.ok(surface);
  assert.match(surface, /data-openbitfun-layout="compact"/);
  assert.match(markup, /data-openbitfun-part="startActions"/);
  assert.match(markup, /data-openbitfun-part="content"/);
  assert.match(markup, /data-openbitfun-part="endActions"/);
  assert.match(markup, /aria-label="Message"/);
});

test("ChatComposer exposes expanded, busy, and disabled state without owning editor behavior", () => {
  const markup = renderToStaticMarkup(
    createElement(ChatComposer, {
      busy: true,
      disabled: true,
      layout: "expanded",
      children: createElement("div", { contentEditable: true }),
    }),
  );

  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, /data-openbitfun-state="busy disabled"/);
  assert.match(markup, /data-openbitfun-layout="expanded"/);
  assert.doesNotMatch(markup, /data-openbitfun-part="contextBar"/);
  assert.match(markup, /contenteditable="true"/);
});

test("ChatComposer exposes a neutral pending-message queue with per-message attachment counts", () => {
  const queue = createElement(
    ChatComposerQueue,
    { "aria-label": "Wait for sending" },
    createElement(
      ChatComposerQueueHeader,
      null,
      createElement("svg", { "aria-hidden": true }),
      createElement(ChatComposerQueueTitle, { count: 13 }, "Wait for sending"),
    ),
    createElement(
      ChatComposerQueueList,
      null,
      createElement(
        ChatComposerQueueItem,
        { state: "default", leadingIcon: createElement("svg", { "data-queue-mark": true }) },
        createElement(
          ChatComposerQueueItemContent,
          null,
          createElement(
            ChatComposerQueueItemMessage,
            null,
            createElement("span", { "data-overflow-behavior": "fade" }, "Help me turn these photos into a painted scene."),
            createElement(ChatComposerQueueAttachmentBadge, {
              count: 3,
              label: "3 image attachments",
            }),
          ),
        ),
        createElement(
          ChatComposerQueueItemActions,
          null,
          createElement("button", { "aria-label": "Send now", type: "button" }),
        ),
      ),
    ),
  );
  const markup = renderToStaticMarkup(
    createElement(ChatComposer, {
      children: createElement("textarea", { "aria-label": "Message" }),
      layout: "compact",
      queue,
    }),
  );

  assert.match(markup, /data-openbitfun-part="body"/);
  assert.match(markup, /data-openbitfun-part="queue"/);
  assert.match(markup, /data-openbitfun-component="chat-composer-queue"/);
  assert.match(markup, /data-openbitfun-part="title"[^>]*>.*Wait for sending.*13/s);
  const attachmentBadge = markup.match(
    /<span[^>]*data-openbitfun-part="attachmentCount"[^>]*>3<\/span>/,
  )?.[0];
  assert.ok(attachmentBadge);
  assert.match(attachmentBadge, /aria-label="3 image attachments"/);
  assert.match(markup, /aria-label="Send now"/);
  assert.match(markup, /data-openbitfun-part="leading-icon" aria-hidden="true"><svg data-queue-mark="true"/);
});

test("ChatComposer queue exposes a disclosure toggle and toned per-message status", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ChatComposerQueue,
      null,
      createElement(
        ChatComposerQueueHeader,
        null,
        createElement(
          ChatComposerQueueToggle,
          { "aria-controls": "queue-list", expanded: false },
          createElement(ChatComposerQueueTitle, { count: 2 }, "Queued"),
        ),
      ),
      createElement(
        ChatComposerQueueList,
        { hidden: true, id: "queue-list" },
        createElement(
          ChatComposerQueueItem,
          { state: "failed" },
          createElement(
            ChatComposerQueueItemContent,
            null,
            "Message",
            createElement(ChatComposerQueueItemStatus, { tone: "danger" }, "Send failed"),
          ),
        ),
      ),
    ),
  );

  assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*aria-controls="queue-list"|<button[^>]*aria-controls="queue-list"[^>]*aria-expanded="false"/);
  assert.match(markup, /<ul[^>]*hidden=""[^>]*id="queue-list"|<ul[^>]*id="queue-list"[^>]*hidden=""/);
  assert.match(markup, /data-openbitfun-part="status"[^>]*data-openbitfun-tone="danger"[^>]*>Send failed</);
  assert.match(markup, /data-openbitfun-state="failed"/);
});

test("ChatComposer queue keeps four message rows visible before scrolling", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/composer/ChatComposerQueue.module.css", import.meta.url),
    "utf8",
  );
  const listRule = styles.match(/\.list\s*\{[^}]*\}/s)?.[0];

  assert.ok(listRule);
  const maxBlockSize = listRule.match(/max-block-size:\s*calc\((.*?)\);/s)?.[1];
  assert.ok(maxBlockSize);
  assert.equal(
    (maxBlockSize.match(/--openbitfun-control-height-sm/g) ?? []).length,
    4,
  );
  assert.match(listRule, /gap:\s*0;/);
  assert.match(styles, /\.item\s*\{[^}]*min-block-size:\s*var\(--openbitfun-control-height-sm\)/s);
  assert.match(listRule, /overflow-y:\s*auto/);
  assert.match(listRule, /overscroll-behavior-y:\s*contain/);
});

test("ChatComposer queue keeps actions visible and message ink primary", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/composer/ChatComposerQueue.module.css", import.meta.url),
    "utf8",
  );
  const actionsRule = styles.match(/\.actions\s*\{[^}]*\}/s)?.[0];
  const contentRule = styles.match(/\.content\s*\{[^}]*\}/s)?.[0];
  assert.ok(actionsRule);
  assert.ok(contentRule);
  assert.match(actionsRule, /display:\s*inline-flex/);
  assert.doesNotMatch(styles, /pointer-events:\s*none|opacity:\s*0(?:;|\s)/);
  assert.match(contentRule, /color:\s*var\(--openbitfun-color-content-primary\)/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(styles, /\.item:focus-within\s*\{[^}]*background:/s);
  assert.match(styles, /@container composer-queue \(max-width: 22rem\)/);
  assert.match(styles, /\[data-openbitfun-part="label"\]\s*\{\s*display: none;/);
});

test("ChatComposer queue groups attachments with natural-width text and anchors actions to the first line", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/composer/ChatComposerQueue.module.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.message\s*\{[^}]*display:\s*flex;[^}]*min-inline-size:\s*0;[^}]*align-items:\s*center;/s);
  assert.match(styles, /\.message > :global\(\[data-overflow-behavior\]\)\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.attachmentBadge\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.item\s*\{[^}]*align-items:\s*flex-start;/s);
  assert.match(styles, /\.actions\s*\{[^}]*inline-size:\s*calc\(var\(--_queue-primary-action-size\)/s);
  assert.match(styles, /\.actions\s*\{[^}]*min-block-size:\s*var\(--openbitfun-control-height-sm\)/s);
  assert.match(styles, /\.list:has\(\.status\)\s*\{[^}]*max-block-size:/s);
});

test("ChatComposer queue never changes the input surface geometry", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/composer/ChatComposer.module.css", import.meta.url),
    "utf8",
  );
  const bodyRule = styles.match(/\.body\s*\{[^}]*\}/s)?.[0];
  const queueRule = styles.match(/\.queue\s*\{[^}]*\}/s)?.[0];

  assert.ok(bodyRule);
  assert.match(bodyRule, /display:\s*flex/);
  assert.match(bodyRule, /flex-direction:\s*column/);
  assert.match(bodyRule, /gap:\s*var\(--openbitfun-space-2\)/);
  assert.ok(queueRule);
  assert.match(queueRule, /display:\s*contents/);
  assert.doesNotMatch(styles, /\.body:has\(/);
  assert.doesNotMatch(styles, /\.queue:empty/);
});

test("ChatComposer resolves compound slots into the same stable anatomy", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ChatComposer,
      { layout: "expanded" },
      createElement(
        ChatComposerContent,
        null,
        createElement("div", { "data-editor": true }, "Draft"),
      ),
      createElement(
        ChatComposerStartActions,
        null,
        createElement("button", { type: "button" }, "Add"),
      ),
      createElement(
        ChatComposerEndActions,
        null,
        createElement("button", { type: "button" }, "Send"),
      ),
    ),
  );

  assert.match(markup, /data-openbitfun-part="content"[^>]*><div data-editor="true">Draft<\/div>/);
  assert.match(markup, /data-openbitfun-part="startActions"[^>]*><button type="button">Add<\/button>/);
  assert.match(markup, /data-openbitfun-part="endActions"[^>]*><button type="button">Send<\/button>/);
  assert.equal((markup.match(/>Draft</g) ?? []).length, 1);
});

test("ChatComposer geometry is driven by public system and semantic tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--openbitfun-control-height-md/);
  assert.match(styles, /--openbitfun-control-chat-composer-compact-gap/);
  assert.match(styles, /--openbitfun-control-chat-composer-compact-height/);
  assert.match(styles, /--openbitfun-control-chat-composer-compact-padding-block/);
  assert.match(styles, /--openbitfun-control-chat-composer-compact-padding-inline/);
  assert.match(styles, /--openbitfun-control-chat-composer-compact-track-height/);
  assert.match(styles, /--openbitfun-control-chat-composer-action-icon-size/);
  assert.match(styles, /--openbitfun-control-chat-composer-control-height/);
  assert.match(styles, /--openbitfun-space-8/);
  assert.match(styles, /--openbitfun-control-composer-surface-radius/);
  assert.match(styles, /--openbitfun-color-surface-panel/);
  assert.match(styles, /--openbitfun-color-surface-subtle/);
  assert.match(styles, /--openbitfun-color-surface-raised/);
  const contextBackgroundRule = styles.match(
    /\.\w+\[data-has-context=(?:"true"|true)\][^{]*\{[^}]*\}/,
  );
  assert.ok(contextBackgroundRule);
  assert.match(contextBackgroundRule[0], /background:\s*var\(--openbitfun-color-composer-context-background\)/);
  assert.match(styles, /--openbitfun-color-composer-border/);
  assert.match(styles, /--openbitfun-shadow-composer/);
  assert.match(
    styles,
    /border:\s*var\(--openbitfun-border-width-default\)\s+solid\s+var\(--openbitfun-color-composer-border\)/,
  );
  assert.match(styles, /min-block-size:\s*var\(--openbitfun-control-height-md\)/);
  assert.match(styles, /grid-template-areas:\s*"start content end"/);
  assert.match(
    styles,
    /grid-template-rows:\s*var\(--openbitfun-control-chat-composer-compact-track-height\)/,
  );
  assert.match(styles, /"content content"\s*"start end"/);
  assert.match(
    styles,
    /\[data-openbitfun-layout=(?:"compact"|compact)\][^{]*\{[^}]*block-size:\s*var\(--openbitfun-control-chat-composer-compact-height\)[^}]*border-radius:\s*var\(--openbitfun-control-composer-surface-radius\)/,
  );
  assert.match(
    styles,
    /\[data-openbitfun-layout=(?:"compact"|compact)\][^{]*\.\w+\s*\{[^}]*block-size:\s*var\(--openbitfun-control-chat-composer-compact-track-height\)[^}]*align-self:\s*center/,
  );
});
