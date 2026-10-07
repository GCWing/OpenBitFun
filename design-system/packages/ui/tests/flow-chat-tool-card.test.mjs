import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignSystemProvider } from "../dist/index.js";
import {
  AgentControlToolCard,
  AgentWaitToolCard,
  AmbientToolCard,
  AmbientToolCardHeader,
  CommandToolCard,
  ContextCompressionToolCard,
  CronToolCard,
  DefaultToolCard,
  DirectoryListToolCard,
  FileDiffToolCard,
  FileOperationToolCard,
  GetToolSpecToolCard,
  GitToolCard,
  GlobSearchToolCard,
  GrepSearchToolCard,
  PageDeployToolCard,
  PagePublishToolCard,
  ProminentToolCard,
  ProminentToolCardSummary,
  ReadFileToolCard,
  ReviewSummaryToolCard,
  RunCodeToolCard,
  SessionControlToolCard,
  SessionMessageToolCard,
  SkillToolCard,
  TerminalControlToolCard,
  TodoToolCard,
  ToolCardChangeSummary,
  ToolCardActions,
  ToolCardCopyButton,
  ToolCardDisclosure,
  ToolCardStatusSlot,
  ToolCapsulePresentationProvider,
  ToolCapsuleDetails,
  ViewImageToolCard,
  WebFetchToolCard,
  WebSearchToolCard,
} from "../dist/flow-chat.js";

const capsulePresentation = {
  label: 'src/index.ts', description: 'Read file · /work/src/index.ts · Failed',
  status: 'error', statusLabel: 'Failed', expanded: false, onExpandedChange() {},
  fallbackContent: createElement(ToolCapsuleDetails, { fields: [], error: 'Access denied' }),
};

test('tool-card disclosure preserves accessible state and keeps actions outside its toggle and region', () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(createElement(ToolCardDisclosure, {
      open,
      summary: 'Parameters',
      description: 'Recorded input',
      actions: createElement('button', { type: 'button' }, 'Copy parameters'),
    }, createElement('pre', null, '{"path":"report.md"}')));
    const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
    assert.equal(buttons.length, 2);
    assert.match(buttons[0], new RegExp(`aria-expanded="${open}"`));
    assert.match(buttons[0], /Parameters.*Recorded input/);
    assert.doesNotMatch(buttons[0], /Copy parameters/);
    assert.match(buttons[1], /Copy parameters/);
    const contentId = buttons[0].match(/aria-controls="([^"]+)"/)[1];
    const triggerId = buttons[0].match(/ id="([^"]+)"/)[1];
    const region = html.match(/<div[^>]+role="region"[^>]*>/)[0];
    assert.ok(region.includes(`id="${contentId}"`));
    assert.ok(region.includes(`aria-labelledby="${triggerId}"`));
    assert.ok(region.includes(`aria-hidden="${!open}"`));
    assert.equal(region.includes('inert=""'), !open);
    assert.ok(html.indexOf(buttons[1]) < html.indexOf(region));
  }
});

test('ambient headers distinguish plain targets, recorded results and icon-only failures', () => {
  for (const [locale, action, expected] of [['en-US', 'Search:', 'Search: '], ['zh-CN', '搜索：', '搜索：']]) {
    const html = renderToStaticMarkup(createElement(DesignSystemProvider, { locale },
      createElement(AmbientToolCard, { status: 'completed', header: createElement(AmbientToolCardHeader, {
        action, content: 'needle', result: 0, icon: createElement('svg'),
      }) }),
    ));
    assert.match(html, /data-variant="plain"/);
    assert.match(html, /data-openbitfun-part="resultSummary"[^>]*>.*?>0<\/span>/);
    assert.ok(html.includes(`${expected}</span>`));
    assert.doesNotMatch(html, /Search::|搜索：：/);
  }
  const failed = renderToStaticMarkup(createElement(AmbientToolCard, {
    status: 'error', header: createElement(AmbientToolCardHeader, {
      action: 'Read', content: 'report.md', statusDescription: 'Access denied',
      icon: createElement(ToolCardStatusSlot, { status: 'error', toolIcon: createElement('svg') }),
    }),
  }));
  assert.match(failed, /aria-label="Access denied" role="img" tabindex="0"/);
  assert.match(failed, /report\.md/);
  assert.doesNotMatch(failed, /data-openbitfun-part="extra"|>Access denied</);
});

test('unresolved agent identities use static hatch artwork without inventing navigation', () => {
  const html = renderToStaticMarkup(createElement(SessionMessageToolCard, {
    status: 'completed', action: 'Send',
    interaction: { operation: 'send', target: { label: 'Agent', kind: 'agent' } },
  }));
  assert.match(html, /data-openbitfun-component="subagent-hatch"/);
  assert.match(html, /data-phase="stopped"/);
  assert.doesNotMatch(html, /lucide-bot|data-openbitfun-affordance="open-panel-right"/);
});

test('interaction identities retain host avatars and direction without status badges', () => {
  const html = renderToStaticMarkup(createElement(SessionMessageToolCard, {
    status: 'error', action: 'Send', summary: 'Supporting detail',
    interaction: { operation: 'send',
      source: { label: 'Current chat', kind: 'session' },
      target: { label: 'Curious Otter', kind: 'agent', avatar: createElement('svg', { 'data-avatar': 'otter' }) },
    },
  }));
  assert.match(html, /Current chat/);
  assert.match(html, /Curious Otter/);
  assert.match(html, /data-avatar="otter"/);
  assert.match(html, /data-openbitfun-name="arrow-right"/);
  assert.doesNotMatch(html, /data-openbitfun-component="status-pill"|data-tone="danger"/);
});

test('Grep excerpts separate file paths, line numbers and escaped code while retaining raw notices', () => {
  const html = renderToStaticMarkup(createElement(GrepSearchToolCard, {
    status: 'completed',
    summary: 'needle',
    isExpanded: true,
    onToggle() {},
    resultText: 'legacy fallback',
    resultBlocks: [
      { kind: 'file', path: 'src/app.ts', lines: [
        { kind: 'context', lineNumber: 8, text: '  before()' },
        { kind: 'match', lineNumber: 9, text: '  <needle value="a:12:b" />' },
        { kind: 'match', lineNumber: 42, text: '' },
      ] },
      { kind: 'text', text: 'Output truncated for session preview' },
    ],
  }));
  assert.equal((html.match(/data-openbitfun-part="grepFilePath"/g) ?? []).length, 1);
  assert.equal((html.match(/data-openbitfun-part="grepLineNumber"/g) ?? []).length, 3);
  assert.match(html, /data-kind="context"/);
  assert.match(html, /data-gap-before="true"/);
  assert.match(html, /data-openbitfun-part="grepLineContent">  &lt;needle value=&quot;a:12:b&quot; \/&gt;<\/pre>/);
  assert.match(html, /Output truncated for session preview/);
  assert.doesNotMatch(html, /legacy fallback/);
  assert.doesNotMatch(html, /src\/app\.ts:9:/);

  const fallback = renderToStaticMarkup(createElement(GrepSearchToolCard, {
    status: 'completed', summary: 'needle', isExpanded: true,
    resultText: 'src/app.ts:12', onToggle() {},
  }));
  assert.match(fallback, /data-openbitfun-part="resultText">src\/app\.ts:12<\/pre>/);
});

test('Grep shares the widest line-number track across files and preserves a minimum gutter', () => {
  for (const [lastLine, width] of [[42, 3], [10000, 5]]) {
    const html = renderToStaticMarkup(createElement(GrepSearchToolCard, {
      status: 'completed', summary: 'needle', isExpanded: true, onToggle() {},
      resultBlocks: [
        { kind: 'file', path: 'src/first.ts', lines: [{ kind: 'match', lineNumber: 9, text: 'first' }] },
        { kind: 'text', text: 'Output notice' },
        { kind: 'file', path: 'src/last.ts', lines: [{ kind: 'match', lineNumber: lastLine, text: 'last' }] },
      ],
    }));
    const sharedResults = html.match(/<div[^>]+data-openbitfun-part="grepResults"[^>]*>/)[0];
    assert.ok(sharedResults.includes(`--_grep-line-number-width:${width}ch`));
    assert.equal((html.match(/--_grep-line-number-width:/g) ?? []).length, 1);
    assert.equal((html.match(/data-openbitfun-part="grepFile"/g) ?? []).length, 2);
  }
});

test('ambient commands keep failures accessible from the icon and expand the error with output', () => {
  const props = { action: 'Run command', attention: 'ambient', command: 'pnpm test',
    emptyCommand: 'No command', isExpanded: false, status: 'completed',
    output: createElement('pre', null, 'output'), onToggle() {} };
  const closed = renderToStaticMarkup(createElement(CommandToolCard, props));
  assert.match(closed, /data-openbitfun-attention="ambient"/);
  assert.match(closed, /data-openbitfun-expanded-shell="false"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /data-tool-capsule="true"|data-openbitfun-attention="prominent"/);
  const failed = renderToStaticMarkup(createElement(CommandToolCard, { ...props, status: 'error', error: 'Command failed' }));
  assert.match(failed, /Command failed/);
  assert.doesNotMatch(failed, />Command failed</);
  const expanded = renderToStaticMarkup(createElement(CommandToolCard, { ...props, status: 'error', error: 'Command failed', isExpanded: true }));
  assert.match(expanded, />Command failed</);
  assert.match(expanded, /<pre>output<\/pre>/);
  const approval = renderToStaticMarkup(createElement(CommandToolCard, { ...props,
    requiresConfirmation: true, status: 'pending_confirmation' }));
  assert.match(approval, /data-openbitfun-attention="ambient"/);
  assert.match(approval, /data-openbitfun-state="confirmation"/);
  assert.match(approval, /data-default-icon="tool"/);
  assert.doesNotMatch(approval, /data-openbitfun-attention="prominent"/);
});

test('capsules retain a type icon, expose an accessible button and reveal actual failures', () => {
  const render = expanded => renderToStaticMarkup(createElement(ToolCapsulePresentationProvider,
    { value: { ...capsulePresentation, expanded } },
    createElement(ReadFileToolCard, { status: 'error', action: 'Read file', content: 'Old summary' }),
  ));
  const closed = render(false);
  assert.match(closed, /<button[^>]*aria-label="Read file · \/work\/src\/index.ts · Failed"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /lucide-file-text/);
  assert.match(closed, /src\/index.ts/);
  assert.doesNotMatch(closed, /Old summary|iconAffordanceButton|Access denied/);
  const expanded = render(true);
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /Access denied/);
});

test('capsule composition preserves specialized result bodies and does not change prominent cards', () => {
  const nativeDetails = createElement('div', null, 'Native search result');
  const ambient = renderToStaticMarkup(createElement(ToolCapsulePresentationProvider,
    { value: { ...capsulePresentation, expanded: true } },
    createElement(AmbientToolCard, { status: 'completed', expandedContent: nativeDetails,
      onClick() {}, header: createElement(AmbientToolCardHeader, { content: 'Search' }) }),
  ));
  assert.match(ambient, /Native search result/);
  assert.doesNotMatch(ambient, /Access denied/);
  const prominent = createElement(ProminentToolCard, { status: 'completed', isExpanded: true,
    summary: createElement(ProminentToolCardSummary, { action: 'Edit', content: 'index.ts' }),
    expandedContent: createElement('div', null, 'Diff and actions'), onToggle() {} });
  assert.equal(renderToStaticMarkup(createElement(ToolCapsulePresentationProvider, { value: capsulePresentation }, prominent)), renderToStaticMarkup(prominent));
});

test("flow-chat entry publishes the ambient and prominent framework anatomy", () => {
  const ambientMarkup = renderToStaticMarkup(
    createElement(AmbientToolCard, {
      expandedContent: createElement("div", null, "Supporting detail"),
      header: createElement(AmbientToolCardHeader, {
        action: "Read file",
        content: "src/index.ts",
        icon: createElement("svg", { "data-icon": "file" }),
      }),
      onClick() {},
      status: "completed",
    }),
  );
  const prominentMarkup = renderToStaticMarkup(
    createElement(ProminentToolCard, {
      expandedContent: createElement("div", null, "Command output"),
      summary: createElement(ProminentToolCardSummary, {
        action: "Run command",
        actions: createElement(
          ToolCardActions,
          null,
          createElement(ToolCardCopyButton, { label: "Copy", onPress() {} }),
        ),
        content: createElement("code", null, "pnpm test"),
        extra: createElement(ToolCardChangeSummary, {
          additions: 6,
          "aria-label": "6 additions and 0 deletions",
          deletions: 0,
        }),
        icon: createElement("svg", { "data-icon": "terminal" }),
      }),
      onToggle() {},
      status: "completed",
    }),
  );

  assert.match(ambientMarkup, /data-openbitfun-attention="ambient"/);
  assert.match(ambientMarkup, /data-openbitfun-part="surface"/);
  assert.match(ambientMarkup, /data-openbitfun-part="iconAffordanceButton"/);
  assert.match(ambientMarkup, /aria-label="Expand details"/);
  assert.match(prominentMarkup, /data-openbitfun-attention="prominent"/);
  assert.match(prominentMarkup, /data-openbitfun-part="summary"/);
  assert.doesNotMatch(prominentMarkup, /data-openbitfun-part="header"/);
  assert.match(prominentMarkup, /data-openbitfun-part="extra"/);
  assert.match(prominentMarkup, /data-openbitfun-part="changeSummary"/);
  assert.match(prominentMarkup, /data-openbitfun-change="added">\+6/);
  assert.match(prominentMarkup, /data-openbitfun-change="removed">-0/);
  assert.match(prominentMarkup, /data-openbitfun-part="actionRegion"/);
  assert.match(prominentMarkup, /data-openbitfun-part="actions"/);
  assert.match(prominentMarkup, /data-openbitfun-part="copyButton"/);
  assert.match(prominentMarkup, /data-openbitfun-part="affordanceButton"/);
  assert.match(prominentMarkup, /aria-expanded="false"/);
  assert.doesNotMatch(prominentMarkup, /lucide-chevron-down/);
});

test("panel-open actions stay in the trailing action region after metadata", () => {
  for (const content of ["Architecture Map", undefined]) {
    const markup = renderToStaticMarkup(createElement(ProminentToolCard, {
      status: "completed", summaryAffordanceKind: "open-panel-right",
      summaryExpandAffordance: true, onToggle() {},
      summary: createElement(ProminentToolCardSummary, {
        action: "Canvas", content, extra: "Ready",
        actions: createElement("button", { type: "button" }, "Export"),
      }),
    }));
    const open = markup.indexOf('data-openbitfun-part="affordanceButton"');
    const actions = markup.indexOf('data-openbitfun-part="actionRegion"');
    const extra = markup.indexOf('data-openbitfun-part="extra"');
    assert.ok(markup.indexOf(content ?? "Canvas") < extra);
    assert.ok(extra < actions && actions < open);
    assert.doesNotMatch(markup, /data-openbitfun-part="contentActions"/);
    assert.equal((markup.match(/data-openbitfun-part="affordanceButton"/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /aria-expanded=/);
  }
});

test("tool-card pointer cursors are limited to interactive surfaces and buttons", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const iconButtonStyles = await readFile(
    new URL("../src/components/IconButton/IconButton.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /\.prominentSurface\s*\{[^}]*cursor:\s*default;/s);
  assert.match(styles, /\.prominentSurface\[data-openbitfun-interactive="true"\]\s*\{\s*cursor:\s*pointer;/s);
  assert.match(styles, /\.ambientSurface\s*\{[^}]*cursor:\s*default;/s);
  assert.match(styles, /\.ambientSurface\[data-openbitfun-interactive="true"\]\s*\{\s*cursor:\s*pointer;/s);
  assert.match(iconButtonStyles, /\.button\s*\{[^}]*cursor:\s*pointer;/s);
});

test("tool-card summary surfaces prevent accidental text selection without locking details", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const surfaceRule = styles.match(/\.surface\s*\{([^}]*)\}/s)?.[1];
  const collapseRule = styles.match(/\.collapse\s*\{([^}]*)\}/s)?.[1];

  assert.ok(surfaceRule);
  assert.ok(collapseRule);
  assert.match(surfaceRule, /-webkit-user-select:\s*none/);
  assert.match(surfaceRule, /user-select:\s*none/);
  assert.doesNotMatch(collapseRule, /user-select/);
});

test("tool-card change summaries use the same markers as the code diff", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );

  assert.match(
    styles,
    /\.changeSummary \[data-openbitfun-change="added"\]\s*\{\s*color: var\(--openbitfun-color-code-diff-added-marker\);/,
  );
  assert.match(
    styles,
    /\.changeSummary \[data-openbitfun-change="removed"\]\s*\{\s*color: var\(--openbitfun-color-code-diff-removed-marker\);/,
  );
});

test("prominent error status opens error content without a separate failure flag", () => {
  const markup = renderToStaticMarkup(
    createElement(ProminentToolCard, {
      errorContent: createElement("div", null, "Command failed"),
      summary: createElement(ProminentToolCardSummary, { action: "Run command" }),
      status: "error",
    }),
  );

  assert.match(markup, /data-openbitfun-state="failed"/);
  assert.match(markup, /data-openbitfun-part="errorCollapse"[^>]+data-open="true"/);
  assert.match(markup, /data-openbitfun-part="error"/);
  assert.match(markup, /Command failed/);
});

test("prominent error status can opt into expandable supporting details", () => {
  const markup = renderToStaticMarkup(
    createElement(ProminentToolCard, {
      allowExpandedWhenFailed: true,
      errorContent: createElement("div", null, "Command failed"),
      expandedContent: createElement("div", null, "Invocation input"),
      summary: createElement(ProminentToolCardSummary, { action: "Run command" }),
      isExpanded: true,
      onToggle() {},
      status: "error",
    }),
  );

  assert.match(markup, /data-openbitfun-state="expanded failed"/);
  assert.match(markup, /data-openbitfun-expandable="true"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /data-openbitfun-part="expandedCollapse"[^>]+data-open="true"/);
  assert.match(markup, /Invocation input/);
  assert.match(markup, /data-openbitfun-part="errorCollapse"[^>]+data-open="true"/);
  assert.match(markup, /Command failed/);
});

test("ordinary failure details honor disclosure for commands, diffs, pages and compression", () => {
  const views = [
    [CommandToolCard, { action: 'Run', command: 'build' }],
    [FileDiffToolCard, { action: 'Diff', path: '/repo/a.ts', pathLabel: 'a.ts' }],
    [GitToolCard, { action: 'Git', command: 'git status' }],
    [PageDeployToolCard, { action: 'Deploy', subject: 'Page' }],
    [PagePublishToolCard, { action: 'Publish', subject: 'Page' }],
    [ContextCompressionToolCard, { title: 'Compress context' }],
  ];
  for (const [View, props] of views) {
    const render = isExpanded => renderToStaticMarkup(createElement(View, {
      ...props, status: 'error', error: 'Detailed failure', isExpanded, onToggle() {},
    }));
    assert.doesNotMatch(render(false), /Detailed failure/);
    assert.match(render(false), /aria-expanded="false"/);
    assert.match(render(true), /Detailed failure/);
    assert.match(render(true), /aria-expanded="true"/);
  }
});

test("cancelled and rejected tool cards rely on status copy instead of a duplicate x glyph", () => {
  for (const [status, statusLabel] of [
    ["cancelled", "Cancelled"],
    ["rejected", "Rejected"],
  ]) {
    const agentMarkup = renderToStaticMarkup(
      createElement(AgentControlToolCard, {
        agentName: "reviewer",
        status,
        statusLabel,
      }),
    );

    assert.match(agentMarkup, new RegExp(`data-openbitfun-part="agentStatus"[^>]*><span[^>]*>${statusLabel}<`));
    assert.doesNotMatch(agentMarkup, /data-openbitfun-part="status"/);
    assert.doesNotMatch(agentMarkup, /lucide-x/);
  }

  const ambientMarkup = renderToStaticMarkup(
    createElement(DefaultToolCard, {
      displayName: "Custom tool",
      icon: createElement("svg", { "data-icon": "custom-tool" }),
      status: "cancelled",
      summary: "Cancelled",
      toolName: "custom_tool",
    }),
  );

  assert.match(ambientMarkup, /data-openbitfun-part="statusSlot"[^>]+data-default-icon="tool"/);
  assert.match(ambientMarkup, /data-openbitfun-part="toolIconLayer"/);
  assert.match(ambientMarkup, /data-icon="custom-tool"/);
  assert.doesNotMatch(ambientMarkup, /data-openbitfun-part="statusLayer"|lucide-x/);
});

test("default tool cards replace legacy text icons with a semantic fallback", () => {
  const markup = renderToStaticMarkup(createElement(DefaultToolCard, {
    displayName: "Custom tool",
    toolName: "custom_tool",
    icon: "TOOL",
    status: "cancelled",
    summary: "Cancelled",
  }));
  assert.doesNotMatch(markup, />TOOL</);
  assert.match(markup, /lucide-wrench/);
});

test("tool identity leads completed rows while status-only and failed rows retain status glyphs", () => {
  const statusOnly = renderToStaticMarkup(createElement(ToolCardStatusSlot, { status: "completed" }));
  const failedSearch = renderToStaticMarkup(createElement(GlobSearchToolCard, {
    status: "error",
    summary: "Search failed",
  }));
  assert.match(statusOnly, /data-default-icon="status"/);
  assert.match(statusOnly, /lucide-check/);
  assert.match(failedSearch, /data-default-icon="status"/);
  assert.match(failedSearch, /lucide-x/);
});

test("file-operation failures stay collapsed and use the warning emphasis status icon", async () => {
  const createFailedCard = (isExpanded) => renderToStaticMarkup(
    createElement(FileOperationToolCard, {
      actionLabel: "Edit failed",
      error: {
        message: "The target text was not found.",
        title: "Detailed failure",
      },
      isExpanded,
      onToggle() {},
      operation: "edit",
      path: "src/index.ts",
      pathLabel: "src/index.ts",
      status: "error",
    }),
  );
  const collapsedMarkup = createFailedCard(false);
  const expandedMarkup = createFailedCard(true);
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FileOperationToolCard.module.css", import.meta.url),
    "utf8",
  );

  assert.match(collapsedMarkup, /data-openbitfun-state="failed"/);
  assert.match(collapsedMarkup, /data-openbitfun-expandable="true"/);
  assert.match(collapsedMarkup, /aria-expanded="false"/);
  assert.match(collapsedMarkup, /data-openbitfun-icon="warning"/);
  assert.match(collapsedMarkup, /data-openbitfun-part="errorCollapse"[^>]+data-open="false"/);
  assert.match(collapsedMarkup, /src\/index\.ts/);
  assert.doesNotMatch(collapsedMarkup, /Detailed failure/);
  assert.doesNotMatch(collapsedMarkup, /The target text was not found\./);
  assert.match(expandedMarkup, /data-openbitfun-state="expanded failed"/);
  assert.match(expandedMarkup, /aria-expanded="true"/);
  assert.match(expandedMarkup, /data-openbitfun-part="errorCollapse"[^>]+data-open="true"/);
  assert.match(expandedMarkup, /Detailed failure/);
  assert.match(expandedMarkup, /The target text was not found\./);
  assert.match(
    styles,
    /\.warningStatusIcon\s*\{\s*color: var\(--openbitfun-color-status-warning-emphasis\);/,
  );
  assert.match(
    styles,
    /\.errorTitle > :where\(svg, img, \[data-openbitfun-component="icon"\]\)\s*\{[^}]*inline-size: var\(--openbitfun-font-size-xl\);[^}]*block-size: var\(--openbitfun-font-size-xl\);/s,
  );
});

test("auxiliary actions reveal on hover or keyboard focus and remain available without hover", async () => {
  const styles = await readFile(new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url), "utf8");

  assert.match(styles, /data-openbitfun-preview-state="hover"/);
  assert.match(styles, /:has\(:focus-visible\)/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.match(styles, /opacity:\s*0/);
  assert.match(styles, /pointer-events:\s*none/);
  assert.match(styles, /margin-inline-start:\s*auto/);
  assert.match(styles, /font-variant-numeric:\s*proportional-nums/);
  assert.match(styles, /--openbitfun-control-height-sm/);
  assert.match(styles, /--openbitfun-space-6/);
  assert.match(styles, /--openbitfun-radius-md/);
  assert.match(styles, /--openbitfun-color-focus-ring/);
});

test("FlowChat tool-card shells stay flat at rest and on hover", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const prominentRule = styles.match(/\.prominentRoot\s*\{([^}]*)\}/s)?.[1];
  const ambientExpandedRule = styles.match(/\.ambientExpandedShell\s*\{([^}]*)\}/s)?.[1];

  assert.ok(prominentRule);
  assert.ok(ambientExpandedRule);
  assert.match(prominentRule, /box-shadow:\s*none/);
  assert.match(ambientExpandedRule, /box-shadow:\s*none/);
  assert.match(ambientExpandedRule, /background-color:\s*transparent/);
  assert.doesNotMatch(styles, /\.ambient(?:Root|ExpandedShell)::after/);
  assert.doesNotMatch(styles, /box-shadow:\s*var\(--openbitfun-shadow-(?:xs|sm)\)/);
  assert.doesNotMatch(styles, /box-shadow\s+var\(--_tool-card-transition\)/);
});

test("ambient disclosure keeps compact headers and puts detail in a separate tokenized surface", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const ambientSurfaceRule = styles.match(/\.ambientSurface\s*\{([^}]*)\}/s)?.[1];
  const expandedRule = styles.match(/\.ambientExpanded\s*\{([^}]*)\}/s)?.[1];
  const subjectRule = styles.match(/\.ambientSubject,\s*\.ambientResult\s*\{([^}]*)\}/s)?.[1];
  const resultRule = styles.match(/\.ambientResult,\s*\.ambientSubject\[data-variant="tinted"\]\s*\{([^}]*)\}/s)?.[1];

  assert.ok(ambientSurfaceRule);
  assert.ok(expandedRule);
  assert.ok(subjectRule);
  assert.ok(resultRule);
  assert.match(
    ambientSurfaceRule,
    /min-block-size:\s*max\(1lh,\s*var\(--openbitfun-control-tool-card-ambient-row-min-block-size\)\)/,
  );
  assert.doesNotMatch(ambientSurfaceRule, /--openbitfun-control-height-sm/);
  assert.doesNotMatch(styles, /\.ambientExpandedShell \.ambientSurface/);
  assert.match(expandedRule, /margin-block-start:\s*var\(--openbitfun-space-2\)/);
  assert.match(expandedRule, /border-block-start:\s*0/);
  assert.match(expandedRule, /border-radius:\s*var\(--openbitfun-radius-md\)/);
  assert.match(expandedRule, /background:\s*var\(--openbitfun-color-surface-tertiary\)/);
  assert.match(subjectRule, /max-inline-size:\s*100%/);
  assert.doesNotMatch(subjectRule, /background/);
  assert.match(resultRule, /border-radius:\s*var\(--openbitfun-radius-sm\)/);
  assert.match(resultRule, /background:\s*var\(--openbitfun-color-action-neutral-surface\)/);
});

test("prominent headers keep their height while hidden actions and empty slots release their space", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const rootRule = styles.match(/\.prominentRoot\s*\{([^}]*)\}/s)?.[1];
  const prominentSummaryRule = styles.match(/\.prominentSummary\s*\{([^}]*)\}/s)?.[1];
  const actionRegionRule = styles.match(/\.prominentSummary \.actionRegion\s*\{([^}]*)\}/s)?.[1];
  const hiddenActionRule = styles.match(/\.toolCardActions\[data-reveal="hover"\]\s*\{([^}]*)\}/s)?.[1];
  const hiddenLayoutRule = styles.match(/\.prominentSummary \.hoverActions\s*\{([^}]*)\}/s)?.[1];
  const revealedLayoutRule = styles.match(/\.prominentSummary:is\(:hover, :has\(:focus-visible\)\) \.hoverActions,[^{]*\{([^}]*)\}/s)?.[1];

  assert.ok(rootRule, "root token block");
  assert.ok(prominentSummaryRule, "prominent summary rule");
  assert.ok(actionRegionRule, "right-aligned prominent action region");
  assert.ok(hiddenActionRule, "shared auxiliary action reveal");
  assert.ok(hiddenLayoutRule, "hidden trailing controls leave the flex layout");
  assert.ok(revealedLayoutRule, "hover and keyboard focus restore trailing controls");

  // The 40px outer surface includes its borders. A 20px layout slot lets the
  // existing larger button hit targets remain usable without growing the row.
  assert.match(rootRule, /--_tool-card-action-size:\s*var\(--openbitfun-space-5\)/);
  assert.match(rootRule, /margin-block:\s*0;/);
  assert.match(rootRule, /border-radius:\s*var\(--openbitfun-control-activity-item-surface-radius\)/);
  assert.match(prominentSummaryRule, /min-block-size:\s*calc\(var\(--openbitfun-control-activity-item-surface-height\) - 2 \* var\(--openbitfun-border-width-default\)\)/);
  assert.match(prominentSummaryRule, /padding-block:\s*var\(--openbitfun-control-activity-item-surface-padding-block\)/);
  assert.match(prominentSummaryRule, /padding-inline:\s*var\(--openbitfun-control-flow-chat-card-padding-inline\);/);
  assert.match(styles, /\.prominentSummary \.actionRegion\s*\{\s*block-size:\s*var\(--openbitfun-space-5\);/);

  // Hidden trailing controls leave no width or flex gap, but remain focusable.
  assert.match(actionRegionRule, /margin-inline-start:\s*auto;/);
  assert.match(hiddenActionRule, /opacity:\s*0;/);
  assert.match(hiddenLayoutRule, /position:\s*absolute;/);
  assert.match(hiddenLayoutRule, /pointer-events:\s*none;/);
  assert.doesNotMatch(hiddenLayoutRule, /display:\s*none|visibility:\s*hidden/);
  assert.match(revealedLayoutRule, /position:\s*static;/);
  assert.match(revealedLayoutRule, /pointer-events:\s*auto;/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.prominentSummary \.hoverActions\s*\{[^}]*position:\s*static;/s);

  // A fragment whose conditions are all false still mounts the slot.
  assert.match(styles, /\.extra:empty\s*\{[^}]*display:\s*none/);
  assert.match(
    styles,
    /\.extra:empty \+ \.statusIcon\[data-divider="true"\]\s*\{[^}]*border-inline-start-width:\s*0/,
  );
});

test("ambient tool-card collapse has no delayed shell state or layout-changing shell chrome", async () => {
  const source = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const ambientExpandedRule = styles.match(/\.ambientExpandedShell\s*\{([^}]*)\}/s)?.[1];

  assert.ok(ambientExpandedRule);
  assert.match(source, /const expandedShell = Boolean\(isExpanded && hasExpandedContent\)/);
  assert.doesNotMatch(source, /keepExpandedShell|collapseTimerRef/);
  assert.doesNotMatch(ambientExpandedRule, /margin|border(?!-color)/);
});

test("FlowChat tool-card summary rows share compact title and content typography", async () => {
  const styles = await readFile(
    new URL("../src/flow-chat/tool-cards/FlowChatToolCard.module.css", import.meta.url),
    "utf8",
  );
  const commandStyles = await readFile(
    new URL("../src/flow-chat/tool-cards/CommandToolCard.module.css", import.meta.url),
    "utf8",
  );
  const fileOperationStyles = await readFile(
    new URL("../src/flow-chat/tool-cards/FileOperationToolCard.module.css", import.meta.url),
    "utf8",
  );
  const rootRule = styles.match(/\.prominentRoot,\s*\.ambientRoot\s*\{([^}]*)\}/s)?.[1];
  const prominentSizeRule = styles.match(/\.actionLabel,\s*\.content,\s*\.extra\s*\{([^}]*)\}/s)?.[1];
  const ambientSizeRule = styles.match(/\.ambientAction,\s*\.ambientContent,\s*\.ambientExtra\s*\{([^}]*)\}/s)?.[1];
  const directChildRule = styles.match(/\.actionLabel > \*,[\s\S]*?\.ambientExtra > \*\s*\{([^}]*)\}/s)?.[1];
  const prominentTitleRule = styles.match(/\.actionLabel\s*\{([^}]*)\}/s)?.[1];
  const prominentContentRule = styles.match(/\.content\s*\{([^}]*)\}/s)?.[1];
  const ambientTitleRule = styles.match(/\.ambientAction\s*\{([^}]*)\}/s)?.[1];
  const ambientContentRule = styles.match(/\.ambientContent\s*\{([^}]*)\}/s)?.[1];
  const changeSummaryRule = styles.match(/\.changeSummary\s*\{([^}]*)\}/s)?.[1];
  const commandRule = commandStyles.match(/\.command\s*\{([^}]*)\}/s)?.[1];
  const filePathRule = fileOperationStyles.match(/\.path\s*\{([^}]*)\}/s)?.[1];

  assert.ok(rootRule);
  assert.ok(prominentSizeRule);
  assert.ok(ambientSizeRule);
  assert.ok(directChildRule);
  assert.ok(prominentTitleRule);
  assert.ok(prominentContentRule);
  assert.ok(ambientTitleRule);
  assert.ok(ambientContentRule);
  assert.ok(changeSummaryRule);
  assert.ok(commandRule);
  assert.ok(filePathRule);
  assert.match(rootRule, /--_tool-card-font-family:\s*var\(--openbitfun-type-body-sm-font-family\)/);
  assert.match(rootRule, /--_tool-card-font-size:\s*var\(--openbitfun-type-body-sm-font-size\)/);
  assert.match(rootRule, /--_tool-card-title-font-weight:\s*var\(--openbitfun-type-label-lg-font-weight\)/);
  assert.match(rootRule, /--_tool-card-content-font-weight:\s*var\(--openbitfun-type-body-sm-font-weight\)/);
  assert.match(rootRule, /font-variant-numeric:\s*proportional-nums/);
  assert.match(prominentSizeRule, /font-size:\s*var\(--_tool-card-font-size\)/);
  assert.match(ambientSizeRule, /font-size:\s*var\(--_tool-card-font-size\)/);
  assert.match(directChildRule, /font:\s*inherit/);
  assert.match(prominentTitleRule, /font-weight:\s*var\(--_tool-card-title-font-weight\)/);
  assert.match(ambientTitleRule, /font-weight:\s*var\(--_tool-card-title-font-weight\)/);
  assert.match(prominentContentRule, /font-weight:\s*var\(--_tool-card-content-font-weight\)/);
  assert.match(ambientContentRule, /font-weight:\s*var\(--_tool-card-content-font-weight\)/);
  assert.match(changeSummaryRule, /font-family:\s*var\(--_tool-card-font-family\)/);
  assert.match(changeSummaryRule, /font-weight:\s*var\(--_tool-card-content-font-weight\)/);
  assert.doesNotMatch(commandRule, /font-(?:family|size|weight):/);
  assert.doesNotMatch(filePathRule, /font-(?:family|size|weight):/);
});

test("tool cards keep monospace in code evidence, separate from labels and prose", async () => {
  const directory = new URL("../src/flow-chat/tool-cards/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".module.css"));
  const codeSelectors = new Map([
    ["CommandToolCard.module.css", ".root .expandedCommand"],
    ["ProminentToolCards.module.css", ".textPreview"],
    ["SearchResultsToolCards.module.css", ".resultText"],
    ["ToolCardDetails.module.css", ".text"],
  ]);

  for (const file of files) {
    let stylesheet = await readFile(new URL(file, directory), "utf8");
    const selector = codeSelectors.get(file);
    if (selector) {
      const rule = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .find((match) => match[1].trim() === selector);
      assert.ok(rule, file);
      assert.match(rule[2], /font-family:\s*var\(--openbitfun-type-flow-code-font-family\)/, file);
      stylesheet = stylesheet.replace(rule[0], "");
    }
    assert.doesNotMatch(stylesheet, /font-family:\s*var\(--openbitfun-type-(?:flow-)?code[^)]*\)/, file);
    assert.doesNotMatch(stylesheet, /font-variant-numeric:\s*tabular-nums/, file);
  }

  const details = await readFile(new URL("ToolCardDetails.module.css", directory), "utf8");
  assert.match(details, /\.text\[data-variant="prose"\]\s*\{[^}]*font-family:\s*var\(--openbitfun-type-body-sm-font-family\)/s);

  const previewStyles = await readFile(
    new URL("../../../apps/design-lab/src/preview/FlowChatPreviewRegistry.css", import.meta.url),
    "utf8",
  );
  assert.equal(previewStyles.match(/--openbitfun-type-code-md-font-family/g)?.length ?? 0, 1);
  assert.doesNotMatch(previewStyles, /font-variant-numeric:\s*tabular-nums/);
  assert.match(
    previewStyles,
    /\.flow-chat-tool-card-preview__diff\s*\{[^}]*font-family:\s*var\(--openbitfun-type-code-md-font-family\)/s,
  );
});

test("command text remains plain when a host applies inline-code chrome", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  const commandRule = styles.match(/\.[_a-zA-Z0-9-]*command[_a-zA-Z0-9-]*\{([^}]*)\}/)?.[1];

  assert.ok(commandRule);
  assert.match(commandRule, /margin:\s*0/);
  assert.match(commandRule, /padding:\s*0/);
  assert.match(commandRule, /border:\s*0/);
  assert.match(commandRule, /border-radius:\s*0/);
  assert.match(commandRule, /background:\s*transparent/);
});

test("ambient card cursors distinguish static traces from interactive cards", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  const staticMarkup = renderToStaticMarkup(
    createElement(AgentWaitToolCard, {
      action: "Wait for agents",
      status: "completed",
      summary: "All agents completed",
    }),
  );

  assert.match(
    styles,
    /ambientSurface[^}]*\{[^}]*cursor:\s*default/s,
  );
  assert.match(
    styles,
    /ambientSurface[^}]*\[data-openbitfun-interactive=["']?true["']?\][^{]*\{[^}]*cursor:\s*pointer/s,
  );
  assert.match(staticMarkup, /data-openbitfun-interactive="false"/);
  assert.doesNotMatch(staticMarkup, /role="button"/);
  assert.doesNotMatch(staticMarkup, /tabindex="0"/);
});

test("standard FlowChat tool views publish their concrete component contracts", () => {
  const readMarkup = renderToStaticMarkup(
    createElement(ReadFileToolCard, {
      action: "Read file:",
      accessibleLabel: "Open src/index.ts",
      content: "src/index.ts · 128 lines",
      interactive: true,
      onOpen() {},
      status: "completed",
    }),
  );
  const contextMarkup = renderToStaticMarkup(
    createElement(ContextCompressionToolCard, {
      status: "completed",
      summary: "Compressed context length 31k (compression ratio 75%)",
      title: "Compress context",
    }),
  );
  const commandMarkup = renderToStaticMarkup(
    createElement(CommandToolCard, {
      action: "Run command",
      command: "pnpm test",
      emptyCommand: "No command",
      footerItems: [{ label: "Exit code", value: "0" }],
      isExpanded: true,
      output: createElement("pre", null, "57 tests passed"),
      status: "completed",
    }),
  );
  const deleteMarkup = renderToStaticMarkup(
    createElement(FileOperationToolCard, {
      actionLabel: "Delete file",
      operation: "delete",
      path: "dist/stale.js",
      pathLabel: "dist/stale.js",
      status: "completed",
    }),
  );
  const editMarkup = renderToStaticMarkup(
    createElement(FileOperationToolCard, {
      actionLabel: "Edit file",
      changeSummary: {
        additions: 6,
        deletions: 0,
        label: "6 additions and 0 deletions",
      },
      isExpanded: true,
      onOpenFile: {
        label: "Open file",
        onPress() {},
        testId: "open-file-action",
      },
      onToggle() {},
      operation: "edit",
      path: "src/index.ts",
      pathLabel: "src/index.ts",
      preview: createElement("pre", null, "+ migrated view"),
      status: "completed",
    }),
  );

  assert.match(readMarkup, /data-openbitfun-tool-card="read-file"/);
  assert.match(readMarkup, /lucide-file-text/);
  assert.match(readMarkup, /data-default-icon="tool"/);
  assert.match(readMarkup, /data-openbitfun-attention="ambient"/);
  assert.match(readMarkup, /data-openbitfun-direct-action="true"/);
  assert.match(readMarkup, /role="button"/);
  assert.match(readMarkup, /tabindex="0"/);
  assert.match(readMarkup, /aria-label="Open src\/index\.ts"/);
  assert.match(contextMarkup, /data-openbitfun-component="context-compression-tool-card"/);
  assert.match(contextMarkup, /data-openbitfun-part="summary"/);
  assert.match(contextMarkup, /Compressed context length 31k \(compression ratio 75%\)/);
  assert.doesNotMatch(contextMarkup, /data-openbitfun-part="(?:savings|meta|tokenChange)"/);
  assert.match(commandMarkup, /data-openbitfun-component="command-tool-card"/);
  assert.match(commandMarkup, /data-openbitfun-part="outputFrame"/);
  assert.match(commandMarkup, /57 tests passed/);
  assert.match(deleteMarkup, /data-openbitfun-operation="delete"/);
  assert.match(deleteMarkup, /data-openbitfun-attention="prominent"/);
  assert.match(deleteMarkup, /data-openbitfun-part="action"><span[^>]*data-overflow="false"[^>]*><span[^>]*data-overflow-content="">Delete file<\/span><\/span><\/span>/);
  assert.match(deleteMarkup, /data-openbitfun-part="content">/);
  assert.match(editMarkup, /data-openbitfun-operation="edit"/);
  assert.match(editMarkup, /data-openbitfun-attention="prominent"/);
  assert.match(editMarkup, /\+ migrated view/);
  assert.match(editMarkup, /data-openbitfun-part="changeSummary"/);
  assert.match(editMarkup, /data-openbitfun-part="affordanceButton"/);
  assert.match(editMarkup, /data-openbitfun-part="actionRegion"/);
  assert.doesNotMatch(editMarkup, /data-openbitfun-part="(?:trailingActions|contentActions)"/);
  assert.match(editMarkup, /data-openbitfun-part="openPanelButton"/);
  assert.match(editMarkup, /data-openbitfun-affordance="open-panel-right"/);
  assert.match(editMarkup, /data-openbitfun-icon="open-panel-right"/);
  assert.equal((editMarkup.match(/<button\b/g) ?? []).length, 2);
  assert.ok(
    editMarkup.indexOf('data-openbitfun-part="changeSummary"')
      < editMarkup.indexOf('data-openbitfun-part="actionRegion"'),
  );
  assert.doesNotMatch(editMarkup, /lucide-file-diff|lucide-chevron-right|lucide-chevron-down/);
});

test("file deletion retains prominent approval and expandable error information", () => {
  const props = {
    actionLabel: "Delete file", operation: "delete", path: "/work/report.md", pathLabel: "report.md",
  };
  const failed = renderToStaticMarkup(createElement(FileOperationToolCard, {
    ...props, status: "error", isExpanded: true, onToggle() {}, error: { message: "Access denied" },
  }));
  assert.match(failed, /data-openbitfun-attention="prominent"/);
  assert.match(failed, /data-openbitfun-status="error"/);
  assert.match(failed, /report\.md/);
  assert.match(failed, /Access denied/);
  const pending = renderToStaticMarkup(createElement(FileOperationToolCard, {
    ...props, status: "pending_confirmation", requiresConfirmation: true,
  }));
  assert.match(pending, /data-openbitfun-state="confirmation"/);
});

test("every migrated FlowChat tool view publishes a stable concrete card identity", () => {
  const cards = [
    ["agent-control", createElement(AgentControlToolCard, {
      agentName: "reviewer",
      onToggle() {},
      prompt: "Review the migration",
      status: "running",
      statusLabel: "Running",
    })],
    ["agent-wait", createElement(AgentWaitToolCard, {
      action: "Wait for agents",
      status: "running",
      summary: "Waiting",
    })],
    ["default", createElement(DefaultToolCard, {
      displayName: "Custom tool",
      status: "completed",
      summary: "Completed",
      toolName: "custom_tool",
    })],
    ["cron", createElement(CronToolCard, {
      action: "Scheduled job:",
      status: "completed",
      summary: "Created scheduled job",
    })],
    ["directory-list", createElement(DirectoryListToolCard, {
      results: [{ key: "src", title: "src/" }],
      status: "completed",
      summary: "18 entries",
    })],
    ["file-diff", createElement(FileDiffToolCard, {
      action: "Get diff",
      changeSummary: {
        additions: 12,
        deletions: 0,
        label: "12 additions and 0 deletions",
      },
      path: "src/index.ts",
      pathLabel: "index.ts",
      status: "completed",
    })],
    ["get-tool-spec", createElement(GetToolSpecToolCard, {
      action: "Read tool spec",
      status: "completed",
      summary: "Loaded",
    })],
    ["git", createElement(GitToolCard, {
      action: "Git",
      command: "git status",
      status: "completed",
    })],
    ["glob-search", createElement(GlobSearchToolCard, {
      status: "completed",
      summary: "42 files",
    })],
    ["grep-search", createElement(GrepSearchToolCard, {
      resultText: "src/index.ts:12",
      status: "completed",
      summary: "1 match",
    })],
    ["page-deploy", createElement(PageDeployToolCard, {
      action: "Deploy page",
      status: "completed",
      subject: "docs",
    })],
    ["page-publish", createElement(PagePublishToolCard, {
      action: "Publish page",
      status: "completed",
      subject: "docs",
    })],
    ["review-summary", createElement(ReviewSummaryToolCard, {
      status: "completed",
      summary: "No blocking issues",
      title: "Review complete",
    })],
    ["run-code", createElement(RunCodeToolCard, {
      action: "Run code",
      status: "completed",
      summary: "Verified",
    })],
    ["session-control", createElement(SessionControlToolCard, {
      action: "Session control",
      status: "completed",
      summary: "Created session",
    })],
    ["session-message", createElement(SessionMessageToolCard, {
      action: "Session message",
      status: "completed",
      summary: "Sent message",
    })],
    ["skill", createElement(SkillToolCard, {
      action: "Skill",
      status: "completed",
      summary: "Loaded",
    })],
    ["terminal-control", createElement(TerminalControlToolCard, {
      action: "Terminal control",
      status: "completed",
      summary: "Interrupted",
    })],
    ["todo", createElement(TodoToolCard, {
      completedCount: 1,
      items: [{ content: "Migrate card", key: "one", status: "completed" }],
      status: "completed",
      title: "Tasks",
      totalCount: 1,
    })],
    ["view-image", createElement(ViewImageToolCard, {
      alt: "Preview",
      source: "data:image/png;base64,AAAA",
      status: "completed",
      statusText: "Viewed image",
    })],
    ["web-fetch", createElement(WebFetchToolCard, {
      status: "completed",
      title: "Fetched page",
    })],
    ["web-search", createElement(WebSearchToolCard, {
      status: "completed",
      summary: "3 results",
    })],
  ];

  for (const [identity, card] of cards) {
    const markup = renderToStaticMarkup(card);
    assert.match(markup, new RegExp(`data-openbitfun-tool-card="${identity}"`), identity);
    if (identity === "skill") {
      assert.match(markup, /lucide-book-open/);
      assert.match(markup, /data-openbitfun-part="statusSlot"[^>]*data-default-icon="tool"/);
    }
    assert.match(markup, /data-openbitfun-component="flow-chat-tool-card"/, identity);
    assert.match(markup, /data-openbitfun-status="(?:completed|running)"/, identity);
  }

  const leadingIcons = {
    default: "wrench",
    cron: "calendar-clock",
    "directory-list": "folder-open",
    "get-tool-spec": "book-search",
    "glob-search": "file-search-corner",
    "grep-search": "text-search",
    "run-code": "code",
    "session-control": "message-circle",
    "session-message": "message-circle",
    skill: "book-open",
    "terminal-control": "square-terminal",
    "view-image": "image",
    "web-fetch": "globe",
    "web-search": "globe",
  };
  for (const [identity, icon] of Object.entries(leadingIcons)) {
    const card = cards.find(([name]) => name === identity)?.[1];
    assert.ok(card, identity);
    const markup = renderToStaticMarkup(card);
    assert.match(markup, new RegExp(`lucide-${icon}`), identity);
    assert.match(markup, /data-openbitfun-part="statusSlot"[^>]*data-default-icon="tool"/, identity);
  }
});

test("file diff summary matches the compact file-operation information hierarchy", async () => {
  const markup = renderToStaticMarkup(createElement(FileDiffToolCard, {
    action: "Get diff:",
    changeSummary: {
      additions: 12,
      deletions: 0,
      label: "12 additions and 0 deletions",
    },
    path: "src/index.ts",
    pathLabel: "index.ts",
    status: "completed",
  }));
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  const pathRule = styles.match(/\.[_a-zA-Z0-9-]*diffPath[_a-zA-Z0-9-]*\{([^}]*)\}/)?.[1];

  assert.match(markup, /data-path="src\/index\.ts"[^>]*data-openbitfun-part="path"[^>]*data-overflow-text="src\/index\.ts"/);
  assert.doesNotMatch(markup, /\stitle=/);
  assert.match(markup, />index\.ts<\/span>/);
  assert.match(markup, /data-openbitfun-part="changeSummary"/);
  assert.match(markup, /aria-label="12 additions and 0 deletions"/);
  assert.match(markup, /data-openbitfun-change="added">\+12/);
  assert.match(markup, /data-openbitfun-change="removed">-0/);
  assert.doesNotMatch(markup, /Git HEAD|data-openbitfun-part="diffType"/);
  assert.ok(pathRule, "file-diff path rule should exist");
  assert.match(pathRule, /var\(--openbitfun-color-content-secondary\)/);
  assert.doesNotMatch(pathRule, /font-(?:family|size|weight):/);
});

test("todo rows identify the task list with a shared icon and expose progress when expanded", () => {
  const props = {
    completedCount: 1,
    items: [
      { content: "Define public component", key: "one", status: "completed" },
      { content: "Migrate FlowChat adapter", key: "two", status: "in_progress" },
      { content: "Remove legacy CSS", key: "three", status: "pending" },
    ],
    status: "running",
    summary: "Migrate FlowChat adapter",
    title: "Tasks",
    totalCount: 3,
  };
  const collapsed = renderToStaticMarkup(createElement(TodoToolCard, props));
  const compact = renderToStaticMarkup(createElement(TodoToolCard, { ...props, mode: "compact" }));

  assert.match(collapsed, /data-openbitfun-attention="prominent"/);

  for (const markup of [collapsed, compact]) {
    assert.match(markup, /data-openbitfun-name="list-todo"/);
    assert.match(markup, /aria-label="Tasks"/);
    assert.match(markup, /stroke-width="var\(--openbitfun-control-icon-stroke-width\)"/);
    assert.match(markup, /Migrate FlowChat adapter/);
    assert.doesNotMatch(markup, /role="progressbar"/);
  }
  assert.doesNotMatch(collapsed, /data-openbitfun-part="action"/);

  const complete = renderToStaticMarkup(createElement(TodoToolCard, {
    ...props, completedCount: 3, summary: "All tasks completed",
  }));
  assert.match(complete, /data-openbitfun-name="list-todo"/);
  assert.match(complete, /All tasks completed/);

  const expanded = renderToStaticMarkup(createElement(TodoToolCard, { ...props, isExpanded: true }));
  assert.match(expanded, /role="progressbar"[^>]*aria-valuenow="1"|aria-valuenow="1"[^>]*role="progressbar"/);
  assert.match(expanded, /aria-valuemax="3"/);
  const expandedComplete = renderToStaticMarkup(createElement(TodoToolCard, {
    ...props, completedCount: 3, isExpanded: true,
  }));
  assert.match(expandedComplete, /aria-valuenow="3"/);
});

test("concrete tool views expose semantic parts instead of legacy CSS selectors", () => {
  const agentMarkup = renderToStaticMarkup(createElement(AgentControlToolCard, {
    agentName: "reviewer",
    onOpenAgent() {},
    openAgentLabel: "Open agent",
    status: "running",
    statusLabel: "Running",
    summary: "Review the shared FlowChat boundary",
    preview: {
      agentType: "Reviewer",
      model: "Model",
      labels: { agentType: "Agent type", model: "Model", description: "Task" },
    },
  }));
  const fetchMarkup = renderToStaticMarkup(createElement(WebFetchToolCard, {
    details: ["markdown"],
    isExpanded: true,
    onOpenUrl() {},
    openUrlLabel: "Open source",
    status: "completed",
    title: "Architecture",
    url: "https://openbitfun.com/docs",
  }));
  const imageMarkup = renderToStaticMarkup(createElement(ViewImageToolCard, {
    alt: "Preview",
    isExpanded: true,
    onOpenPreview() {},
    source: "data:image/png;base64,AAAA",
    status: "completed",
    statusText: "Viewed image",
  }));

  assert.match(agentMarkup, /data-openbitfun-part="agentSummary"/);
  assert.match(agentMarkup, /data-openbitfun-part="agentStatus"/);
  assert.match(agentMarkup, /data-openbitfun-component="shimmer-text"[^>]*>Running<\/span>/);
  assert.match(agentMarkup, /data-agent-capsule-trigger="true"/);
  assert.match(agentMarkup, /data-openbitfun-affordance="open-panel-right"/);
  assert.doesNotMatch(agentMarkup, /aria-expanded|expandedCollapse|interruptAgentButton|lucide-chevron-down/);
  assert.doesNotMatch(agentMarkup, /data-openbitfun-part="statusSlot"|data-openbitfun-part="processing"/);
  assert.match(fetchMarkup, /data-openbitfun-part="sourceLink"/);
  assert.match(fetchMarkup, /data-openbitfun-part="detail"/);
  assert.match(imageMarkup, /data-openbitfun-part="imagePreview"/);
});

test("failed commands retain partial output as well as the error", () => {
  const markup = renderToStaticMarkup(createElement(CommandToolCard, {
    status: "error", isExpanded: true, onToggle() {},
    command: "pnpm test", emptyCommand: "No command",
    output: createElement("pre", null, "Partial test output"), error: "Process interrupted",
  }));
  assert.match(markup, /Partial test output/);
  assert.match(markup, /Process interrupted/);
});

test("failed review summaries keep changed files and the review action available", () => {
  const markup = renderToStaticMarkup(createElement(ReviewSummaryToolCard, {
    status: "error", isExpanded: true, onToggle() {},
    title: "Review failed", summary: "One reviewer could not finish",
    changedFiles: ["/workspace/src/long-directory/report.ts"],
    action: createElement("button", null, "Open review"),
  }));
  assert.match(markup, /One reviewer could not finish/);
  assert.match(markup, /\/workspace\/src\/long-directory\/report.ts/);
  assert.match(markup, /<button[^>]*>Open review<\/button>/);
  assert.match(markup, /aria-expanded="true"/);
});

test("package manifest exposes flow-chat only through built artifacts", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(manifest.exports["./flow-chat"], {
    types: "./dist/types/flow-chat.d.ts",
    import: "./dist/flow-chat.js",
  });
});
