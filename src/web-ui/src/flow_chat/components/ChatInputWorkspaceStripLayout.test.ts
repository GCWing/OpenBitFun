import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESS_PRESENTATION } from '@/shared/agents/harnessPresentation';

function readLocalFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');
}

const readWorkspaceStripStylesheet = () => readLocalFile('ChatInputWorkspaceStrip.scss');
const readChatInputStylesheet = () => readLocalFile('ChatInput.scss');
const readWorkspaceStripComponent = () => readLocalFile('ChatInputWorkspaceStrip.tsx');
const readOverlayLayoutStylesheet = () => readFileSync(
  fileURLToPath(new URL('../../shared/styles/_overlay-layout.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');
const readBranchQuickSwitchStylesheet = () => readFileSync(
  fileURLToPath(new URL('../../tools/git/components/BranchQuickSwitch.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');
const readDispatchTargetPickerComponent = () => readFileSync(
  fileURLToPath(new URL('../../features/dispatch/DispatchTargetPicker.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');
const readDispatchTargetPickerStylesheet = () => readFileSync(
  fileURLToPath(new URL('../../features/dispatch/DispatchTargetPicker.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

describe('composer context track layout', () => {
  it('is two fixed rails rather than a conditional column template', () => {
    const stylesheet = readWorkspaceStripStylesheet();

    expect(stylesheet).toContain('justify-content: space-between;');
    expect(stylesheet).toContain('&__context {');
    expect(stylesheet).toContain('&__next {');
    expect(stylesheet).toContain('min-height: 20px;');
    expect(stylesheet).toContain('border: 0;');
    expect(stylesheet).toContain('background: transparent;');
    // The eight conditional grid templates are what made a control appearing
    // on one side reflow the other. There is no replacement for them.
    expect(stylesheet).not.toContain('grid-template-columns');
    expect(stylesheet).not.toContain('--with-harness');
    expect(stylesheet).not.toContain('--with-policy');
    expect(stylesheet).not.toContain('--with-runtime');
    expect(stylesheet).not.toContain('--actions-only');
    expect(stylesheet).not.toContain('justify-self: end;');
  });

  it('gives the left rail the slack and lets the right rail keep its width', () => {
    const stylesheet = readWorkspaceStripStylesheet();

    expect(stylesheet).toMatch(/&__context \{[\s\S]*?flex: 1 1 auto;/);
    expect(stylesheet).toMatch(/&__next \{[\s\S]*?flex: 0 0 auto;/);
  });

  it('keeps context pickers on one responsive width and one option rhythm', () => {
    const overlayLayout = readOverlayLayoutStylesheet();
    const workspaceStrip = readWorkspaceStripStylesheet();
    const branchPicker = readBranchQuickSwitchStylesheet();
    const targetPicker = readDispatchTargetPickerStylesheet();

    expect(overlayLayout).toContain(
      '@mixin anchored-picker-inline-size($inline-size: 280px)',
    );
    for (const stylesheet of [workspaceStrip, branchPicker, targetPicker]) {
      expect(stylesheet).toContain('@include overlay-layout.anchored-picker-inline-size;');
    }

    expect(branchPicker).toMatch(
      /branch-quick-switch__item \{[\s\S]*?min-height: var\(--openbitfun-control-height-sm\);/,
    );
    for (const stylesheet of [workspaceStrip, branchPicker, targetPicker]) {
      expect(stylesheet).not.toMatch(
        /\[data-openbitfun-part='(?:list|section-items)'\][^{]*\{[^}]*\bgap:/,
      );
    }
    expect(targetPicker).toMatch(
      /&__option-row \{[\s\S]*?min-height: var\(--openbitfun-control-height-md\);/,
    );
    expect(targetPicker).toMatch(
      /&__menu \{[\s\S]*?--openbitfun-overlay-menu-section-gap: var\(--openbitfun-space-1\);/,
    );
    expect(targetPicker).toMatch(
      /&__status \{[\s\S]*?min-height: var\(--openbitfun-overlay-menu-heading-height\);/,
    );
    expect(targetPicker).toMatch(
      /strong \{[\s\S]*?font-size: var\(--openbitfun-type-label-md-font-size\);/,
    );
    expect(targetPicker).toMatch(
      /small \{[\s\S]*?font-size: var\(--openbitfun-type-meta-font-size\);/,
    );
    expect(targetPicker).toMatch(
      /\&\[data-openbitfun-part='option'\] \{[\s\S]*?strong \{[\s\S]*?color: var\(--openbitfun-color-content-secondary\);[\s\S]*?opacity: var\(--openbitfun-opacity-focus\);/,
    );
    expect(targetPicker).toMatch(
      /small \{[\s\S]*?color: var\(--openbitfun-color-content-muted\);[\s\S]*?opacity: 0\.5;/,
    );
  });

  it('reserves one responsive branch-list height across loading and loaded states', () => {
    const branchPicker = readBranchQuickSwitchStylesheet();

    expect(branchPicker).toMatch(
      /branch-quick-switch__list \{[\s\S]*?block-size: clamp\(0px, calc\(100vh - 96px\), 280px\);/,
    );
    expect(branchPicker).toMatch(
      /branch-quick-switch__list \[data-openbitfun-part='list'\] \{[\s\S]*?min-block-size: 100%;/,
    );
    expect(branchPicker).toMatch(
      /branch-quick-switch__loading,[\s\S]*?branch-quick-switch__empty \{[\s\S]*?flex: 1 1 auto;/,
    );
  });

  it('keeps passive context aligned and promotes consequential controls', () => {
    const stylesheet = readWorkspaceStripStylesheet();

    // One role for the whole track, declared once per species. The rail sets
    // the meta size — a quiet context line above the input surface — and its
    // facts inherit it; every control restates the same step through the
    // shared mixin, so the row reads as a single hushed line.
    expect(stylesheet).toContain(
      'font-size: var(--openbitfun-type-flow-meta-font-size);\n  line-height:',
    );
    expect(stylesheet).toMatch(/&__workspace \{[\s\S]*?font-size: inherit;/);
    expect(stylesheet).toMatch(/&__branch \{[\s\S]*?font-size: inherit;/);
    expect(stylesheet).toMatch(
      /@mixin strip-control \{[\s\S]*?font-size: var\(--openbitfun-type-flow-meta-font-size\);/,
    );
    // No control names a size of its own — that is how the track drifted into
    // four of them before.
    const rails = stylesheet.slice(0, stylesheet.indexOf('  &__permission-menu {'));
    expect(rails.match(/font-size:/g)?.length).toBe(2);
    // The rails end where the permission popover begins; that menu is its own
    // surface and is allowed a denser scale than the track.
    expect(rails).not.toContain('$micro-size');
  });

  it('gives the track one pill shape, with a hover fill only on live controls', () => {
    const stylesheet = readWorkspaceStripStylesheet();

    // One shape, declared once. Four heights, three radii and two hover fills
    // across five neighbouring controls is what "unified" is the fix for.
    const mixin = stylesheet.slice(
      stylesheet.indexOf('@mixin strip-control {'),
      stylesheet.indexOf('.openbitfun-chat-input-workspace-strip {'),
    );
    expect(mixin).toContain('height: 18px;');
    expect(mixin).toContain('border-radius: 999px;');
    expect(mixin).toContain('background: transparent;');
    expect(mixin).toMatch(/> svg \{[\s\S]*?width: 12px;/);

    for (const control of [
      '    .dispatch-target-picker__trigger {\n      @include strip-control;',
      '  &__dispatch-result {\n    @include strip-control;',
      '  &__permission-trigger {\n    @include strip-control;',
      '  &__usage-btn {\n    @include strip-control;',
      '  &__worktree-toggle {\n    @include strip-control;',
    ]) {
      expect(stylesheet).toContain(control);
    }

    // The workspace is the row's subject and, with more than one open, its
    // switcher too. It cannot take the mixin — it must shrink on narrow
    // rails, which the mixin's `flex: none` forbids — so it restates the same
    // pill, and the `--switchable` modifier alone owns the hover fill; the
    // static form stays inert beside it at exactly the same size.
    expect(stylesheet).toMatch(/&__workspace \{[\s\S]*?height: 18px;/);
    expect(stylesheet).toMatch(/&__workspace \{[\s\S]*?padding: 0 7px;/);
    expect(stylesheet).toMatch(/&__workspace \{[\s\S]*?border-radius: 999px;/);
    expect(stylesheet).toMatch(/&__workspace \{[\s\S]*?cursor: default;/);
    expect(stylesheet).toMatch(
      /&__workspace--switchable \{[\s\S]*?&:hover:not\(:disabled\)[\s\S]*?background: var\(--openbitfun-color-action-quiet-hover\);/,
    );

    // Branch wears the same pill so the three left-rail segments keep one
    // rhythm. Managed-worktree and dispatch branches stay inert facts, while
    // the ordinary workspace branch opts into the live-control modifier.
    const chip = stylesheet.slice(
      stylesheet.indexOf('  &__chip {'),
      stylesheet.indexOf('  // Isolation switch.'),
    );
    const staticBranch = chip.slice(
      chip.indexOf('    &--branch {'),
      chip.indexOf('    &--branch-switchable {'),
    );
    expect(chip).toContain('cursor: default;');
    expect(staticBranch).not.toContain(':hover');
    expect(staticBranch).toContain('height: 18px;');
    expect(staticBranch).toContain('padding: 0 7px;');
    expect(staticBranch).toContain('border-radius: 999px;');
    expect(chip).toMatch(
      /&--branch-switchable \{[\s\S]*?cursor: pointer;[\s\S]*?&:hover:not\(:disabled\)[\s\S]*?background: var\(--openbitfun-color-action-quiet-hover\);/,
    );

    // A hairline parts the segments; inside a segment spacing is the only
    // grouping, so the two gaps are named and must stay far enough apart to
    // read as a ratio.
    expect(stylesheet).toContain('$track-part-gap: 4px;');
    expect(stylesheet).toContain('$track-item-gap: 10px;');
    expect(stylesheet).toMatch(/&__context \{[\s\S]*?gap: \$track-item-gap;/);
    expect(stylesheet).toMatch(/&__next \{[\s\S]*?gap: \$track-item-gap;/);
    expect(stylesheet).toMatch(/&__chip \{[\s\S]*?gap: \$track-part-gap;/);
    expect(mixin).toContain('gap: $track-part-gap;');

    // Workspace and branch are one coordinate held at the inner gap, so they
    // read as one phrase rather than as two adjacent facts.
    expect(stylesheet).toMatch(/&__location \{[\s\S]*?gap: \$track-part-gap;/);
  });

  it('mounts the track in ChatComposer contextBar without a second positioning system', () => {
    const stylesheet = readWorkspaceStripStylesheet();
    const chatInput = readChatInputStylesheet();
    const component = readLocalFile('ChatInput.tsx');
    const stripRoot = stylesheet.slice(
      stylesheet.indexOf('.openbitfun-chat-input-workspace-strip {'),
      stylesheet.indexOf('  &__context {'),
    );

    expect(component).toContain('contextBar={workspaceStrip}');
    expect(component).toContain('<ChatInputWorkspaceStrip');
    expect(chatInput).toMatch(
      /\.openbitfun-context-drop-zone\.openbitfun-chat-input-drop-zone \{[\s\S]*?padding: 0 var\(--openbitfun-space-2\);/,
    );
    expect(chatInput).toMatch(
      /\.openbitfun-context-drop-zone\.openbitfun-chat-input-drop-zone \{[\s\S]*?bottom: var\(--openbitfun-space-6\);/,
    );
    expect(stripRoot).toContain('position: relative;');
    expect(stripRoot).toContain('padding: 0;');
    expect(stripRoot).not.toContain('position: absolute;');
    expect(stripRoot).not.toContain('bottom:');
    expect(stylesheet).not.toContain('$track-edge');
    expect(chatInput).not.toContain('padding-bottom: 36px;');
  });

  it('orders the left rail as situation and the right rail as the next turn', () => {
    const component = readWorkspaceStripComponent();
    const stylesheet = readWorkspaceStripStylesheet();
    const contextIndex = component.indexOf('data-openbitfun-part="context"');
    const nextIndex = component.indexOf('data-openbitfun-part="next"');
    const contextMarkup = component.slice(contextIndex, nextIndex);
    const locationIndex = contextMarkup.indexOf('__location');
    const targetIndex = contextMarkup.indexOf('<DispatchTargetPicker');

    expect(contextIndex).toBeGreaterThan(-1);
    expect(nextIndex).toBeGreaterThan(contextIndex);
    // Situation reads in geographic order: workspace and branch first, then
    // the execution target. Worktree is a local target mode rather than a
    // third standalone segment.
    expect(component).toContain('<DispatchTargetPicker');
    expect(component).toContain('__location');
    expect(component).toContain('__chip--branch');
    expect(locationIndex).toBeGreaterThan(-1);
    expect(targetIndex).toBeGreaterThan(locationIndex);
    expect(contextMarkup).toContain('localWorktreeControl=');
    // The workspace doubles as the rail's switcher once more than one is
    // open; the menu lists every open workspace and marks the active one.
    expect(component).toContain('data-testid="chat-input-workspace-trigger"');
    expect(component).toContain('data-testid="chat-input-workspace-menu"');
    expect(component).toContain('data-openbitfun-part="workspaceOption"');
    // Every entry carries one compact secondary detail line: repositories use
    // their real path, while assistants expose their product role instead of
    // leaking the internal assistant workspace directory.
    expect(component).toContain('workspace.rootPath?.trim()');
    expect(component).toContain('workspaceContext.primaryAssistantWorkspaceId');
    expect(component).toContain("'workspaceStrip.primaryAssistant'");
    expect(component).toContain("'workspaceStrip.personalAssistant'");
    expect(component).toContain('__workspace-option-detail');
    expect(stylesheet).toMatch(
      /&__workspace-option-copy \{[\s\S]*?padding-block: calc\(var\(--openbitfun-space-1\) \/ 2\);/,
    );
    expect(stylesheet).toMatch(
      /&__workspace-option-detail \{[\s\S]*?color: var\(--openbitfun-color-content-muted\);/,
    );
    expect(stylesheet).toMatch(
      /&__workspace-option-detail \{[\s\S]*?opacity: 0\.5;/,
    );
    // Segments part on a hairline rule, never on a slash: a slash claimed a
    // path that a host, a workspace and a branch do not form.
    expect(component).toContain('__divider');
    expect(stylesheet).toMatch(/&__divider \{[\s\S]*?width: 1px;/);
    expect(component).not.toContain('breadcrumb-separator');
    expect(component).not.toContain('>/</span>');
    // Next turn: how much confirmation it asks for, and how much room is left.
    expect(component).toContain('data-testid="chat-input-permission-trigger"');
    // The ring is the whole reading. A number beside it only said the same
    // thing twice, in the rail with the least room to say anything.
    const usageButton = component.match(
      /className="openbitfun-chat-input-workspace-strip__usage-btn"[\s\S]*?<\/button>/,
    )?.[0];
    expect(usageButton).toBeDefined();
    expect(usageButton).not.toContain('{usagePercentage}%');
    expect(component).toContain('openbitfun-chat-input-workspace-strip__usage-ring');
    expect(component).toContain('data-testid="dispatch-sync-trigger"');
  });

  it('drops the relay hosts now that each control renders where it belongs', () => {
    const component = readWorkspaceStripComponent();

    expect(component).not.toContain('reasoning-host');
    expect(component).not.toContain('permission-host');
    expect(component).not.toContain('HarnessProfileSelector');
    expect(readWorkspaceStripStylesheet()).not.toContain('&__permission-host');
    expect(readLocalFile('ModelSelector.tsx')).not.toContain('reasoningControlHost');
  });

  it('places the compact Harness/main-Agent row inside the add menu', () => {
    const chatInput = readLocalFile('ChatInput.tsx');
    const addMenuIndex = chatInput.indexOf('modeState.dropdownOpen && createOverlayPortal');
    const harnessIndex = chatInput.indexOf('<HarnessProfileSelector');
    const agentBoostIndex = chatInput.indexOf('data-testid="chat-input-agent-boost"');
    const addMenuEndIndex = chatInput.indexOf('getAppearanceOverlayHost()', harnessIndex);
    const newSessionHandlerIndex = chatInput.indexOf(
      'onStartNewSession: requestHarnessNewSession',
    );

    expect(harnessIndex).toBeGreaterThan(-1);
    expect(agentBoostIndex).toBeGreaterThan(-1);
    expect(addMenuIndex).toBeGreaterThan(agentBoostIndex);
    expect(harnessIndex).toBeGreaterThan(agentBoostIndex);
    expect(harnessIndex).toBeGreaterThan(addMenuIndex);
    expect(addMenuEndIndex).toBeGreaterThan(harnessIndex);
    expect(chatInput.match(/<HarnessProfileSelector/g)).toHaveLength(2);
    expect(chatInput).toContain('presentation="menu-item"');
    expect(chatInput).toContain('presentation="standalone"');
    expect(chatInput).toContain(
      "onSelectionComplete={() => dispatchMode({ type: 'CLOSE_DROPDOWN' })}",
    );
    expect(newSessionHandlerIndex).toBeGreaterThan(-1);
    expect(chatInput).toContain(
      'composer.setValue(newSessionId, transferredDraft.value)',
    );
    expect(chatInput).not.toContain('data-testid="chat-input-agent-mode-chip"');
    expect(chatInput).not.toContain("modeState.current !== 'Standard'");
    expect(chatInput).toContain('!isMultiLine && executionLevelPolicy.userConfigurable ? (');
  });

  it('groups quick skill modes after Harness while keeping them out of Assistant sessions', () => {
    const chatInput = readLocalFile('ChatInput.tsx');
    const menuHarnessIndex = chatInput.indexOf('presentation="menu-item"');
    const additionalModesIndex = chatInput.indexOf("label={t('chatInput.boostAdditionalModes')}");
    const quickSkillsIndex = chatInput.indexOf('quickSkillShortcuts.map(shortcut => (');
    const additionalModeItemsIndex = chatInput.indexOf('additionalModeItems.map(item => (');
    const contextIndex = chatInput.indexOf('onClick={handleBoostOpenAtContext}');

    expect(menuHarnessIndex).toBeGreaterThan(-1);
    expect(additionalModesIndex).toBeGreaterThan(menuHarnessIndex);
    expect(quickSkillsIndex).toBeGreaterThan(-1);
    expect(additionalModeItemsIndex).toBeGreaterThan(additionalModesIndex);
    expect(contextIndex).toBeGreaterThan(additionalModeItemsIndex);
    expect(chatInput).toContain('additionalModeItems.map(item => (');
    expect(chatInput).toContain('data-openbitfun-boost-item-kind="additional-mode"');
    expect(chatInput).toContain('data-testid={`chat-input-additional-mode-${item.id}`}');
    expect(chatInput).not.toContain('boost-submenu-item--unavailable');
    expect(chatInput).not.toContain('boost-submenu-item-status');
    expect(chatInput).not.toContain('data-openbitfun-boost-item-kind="workflow"');
    expect(chatInput).not.toContain('data-openbitfun-agent-id="Review"');
    expect(chatInput).toContain(
      'resolveChatInputQuickSkillShortcuts(resolvedModeSkills)',
    );
    expect(chatInput).toContain("chatInputModePolicy.fixedModeId !== 'Claw'");
    expect(chatInput).toContain('layoutRevision: boostMenuLayoutRevision');
    expect(chatInput).toContain('skillName: shortcut.skill.name');
    expect(chatInput).toContain('selectAdditionalMode(item.skillName)');
    expect(chatInput).not.toContain('showReviewAdditionalMode');
    expect(chatInput).not.toContain("modeId: 'review' as const");
    expect(chatInput).not.toContain("selectSlashCommandAction('review')");
  });

  it('keeps custom Agent creation out of the add menu', () => {
    const chatInput = readLocalFile('ChatInput.tsx');

    expect(chatInput).not.toContain('handleOpenCreateCustomMode');
    expect(chatInput).not.toContain("t('chatInput.createCustomMode')");
    expect(chatInput).not.toContain('BotMessageSquare');
  });

  it('moves Harness beside add in expanded layout and keeps the model pair trailing', () => {
    const chatInput = readLocalFile('ChatInput.tsx');
    const stylesheet = readChatInputStylesheet();
    const startActionsIndex = chatInput.indexOf('<ChatComposerStartActions>');
    const menuHarnessIndex = chatInput.indexOf('presentation="menu-item"');
    const standaloneHarnessIndex = chatInput.indexOf('presentation="standalone"');
    const endActionsIndex = chatInput.indexOf('<ChatComposerEndActions>');
    const modelIndex = chatInput.indexOf('<ModelSelector', endActionsIndex);

    expect(menuHarnessIndex).toBeGreaterThan(startActionsIndex);
    expect(standaloneHarnessIndex).toBeGreaterThan(menuHarnessIndex);
    expect(standaloneHarnessIndex).toBeLessThan(endActionsIndex);
    expect(chatInput).toContain('isMultiLine && executionLevelPolicy.userConfigurable ? (');
    expect(stylesheet).toMatch(
      /&\[data-openbitfun-layout='expanded'\] \{[\s\S]*?\.openbitfun-harness-selector__trigger \{[\s\S]*?height: var\(--openbitfun-control-chat-composer-control-height\);/,
    );
    expect(modelIndex).toBeGreaterThan(endActionsIndex);
    expect(chatInput).not.toContain('harnessControl');
    // Reasoning belongs beside the model it configures; context usage remains
    // a ring in the upper context track rather than repeating as a number.
    const modelSelector = readLocalFile('ModelSelector.tsx');
    expect(stylesheet).not.toContain('.openbitfun-reasoning-preset-selector,');
    expect(modelSelector).not.toContain('tokenPercentage');
    expect(modelSelector).not.toContain('data-openbitfun-part="contextUsage"');
    expect(modelSelector).toContain('buildContextUsageTooltip');
    expect(modelSelector).toContain('buildModelSelectorTooltipDetails');
    expect(stylesheet).not.toContain('.openbitfun-model-selector__ctx-usage {');
    expect(stylesheet).toContain(
      ".openbitfun-reasoning-preset-selector[data-openbitfun-presentation='label']",
    );
  });

  it('measures wrapping against ChatComposer compact layout after expansion', () => {
    const component = readLocalFile('ChatInput.tsx');

    expect(component).toContain(
      'clone.querySelector(\n      \'[data-openbitfun-component="chat-composer"] [data-openbitfun-part="surface"]\'',
    );
    expect(component).toContain("cloneComposerSurfaceEl.dataset.openbitfunLayout = 'compact';");
    expect(component).toContain('const singleLineThreshold = paddingBlock + singleLineHeight * 1.5;');
    expect(component).toContain('naturalHeightMeasured > singleLineThreshold');
    expect(component).not.toContain('naturalHeightMeasured > 32');
    expect(component).not.toContain("cloneBoxEl.classList.add('openbitfun-chat-input__box--capsule')");
  });

  it('keeps new workbench sessions expanded while compact conversations start collapsed', () => {
    const component = readLocalFile('ChatInput.tsx');

    expect(component).toContain(
      'const effectiveTargetSessionStarted = effectiveTargetSessionHasTurns',
    );
    expect(component).toContain(
      "|| Boolean(effectiveTargetSession?.lastSubmittedMode?.trim());",
    );
    expect(component).toContain(
      'const isNewSessionComposer = !effectiveTargetSessionStarted;',
    );
    expect(component).toContain(
      "const compactComposer = conversationScope?.presentation === 'compact';",
    );
    expect(component).toContain(
      'const [isMultiLine, setIsMultiLine] = useState(compactComposer ? false : isNewSessionComposer);',
    );
    expect(component).toMatch(
      /const measureIsMultiLine = useCallback[\s\S]*?if \(isNewSessionComposer && !compactComposer\) \{\s*setIsMultiLine\(true\);\s*return;/,
    );
    expect(component).toContain(
      'const harnessProfileLocked = effectiveTargetSessionStarted;',
    );
  });

  it('keeps the model pair borderless at rest, on hover, and while open', () => {
    const stylesheet = readChatInputStylesheet();
    const modelPair = stylesheet.slice(
      stylesheet.indexOf('    .openbitfun-model-selector {'),
      stylesheet.indexOf('    .openbitfun-model-selector__trigger {'),
    );

    expect(modelPair).toContain('border: 0;');
    expect(modelPair).toMatch(
      /&:hover,\s*&\[data-openbitfun-state='open'\] \{\s*background: var\(--openbitfun-color-action-quiet-hover\);/,
    );
    expect(modelPair).not.toContain('border-color:');
  });

  it('uses the shared composer action contract for add and send controls', () => {
    const component = readLocalFile('ChatInput.tsx');
    const stylesheet = readChatInputStylesheet();

    expect(component).toContain('ChatComposerActionButton');
    expect(component).toMatch(
      /className="openbitfun-chat-input__agent-boost-add"[\s\S]*?variant="fill"/,
    );
    expect(component).toMatch(
      /className="openbitfun-chat-input__send-button"[\s\S]*?variant="primary"/,
    );
    expect(stylesheet).not.toContain('.openbitfun-chat-input__agent-boost-add {');
    expect(stylesheet).not.toContain(
      '.openbitfun-chat-input__box:focus-within &:not(:disabled)',
    );
  });

  it('uses the 42px compact surface and keeps 24px controls stable across layouts', () => {
    const component = readLocalFile('ChatInput.tsx');
    const stylesheet = readChatInputStylesheet();
    const compactControls = stylesheet.slice(
      stylesheet.indexOf("    &[data-openbitfun-layout='compact'] {"),
      stylesheet.indexOf('  &--capsule {'),
    );
    expect(compactControls).toContain('height: 100%;');
    expect(stylesheet).toContain(
      'height: var(--openbitfun-control-chat-composer-control-height);',
    );
    expect(compactControls).not.toContain(
      'width: var(--openbitfun-control-chat-composer-compact-track-height) !important;',
    );
    expect(component).toContain('className="openbitfun-chat-input__agent-boost-trigger"');
    expect(stylesheet).toMatch(
      /&__agent-boost-trigger \{[\s\S]*?display: inline-flex;[\s\S]*?height: 100%;[\s\S]*?align-items: center;[\s\S]*?line-height: 0;/,
    );
    expect(readLocalFile('voice/ComposerVoiceInputButton.tsx')).toContain(
      'className="openbitfun-chat-input__voice-control-shell"',
    );
    expect(stylesheet).toMatch(
      /\.openbitfun-chat-input__voice-control-shell \{[\s\S]*?display: inline-flex;[\s\S]*?align-items: center;[\s\S]*?line-height: 0;/,
    );
  });

  it('shows the current mode icon in the compact add menu while keeping profile icons in the list', () => {
    const component = readLocalFile('HarnessProfileSelector.tsx');
    const stylesheet = readLocalFile('HarnessProfileSelector.scss');

    expect(HARNESS_PRESENTATION).toEqual({
      Minimal: { icon: 'minimal', gear: 1 },
      Standard: { icon: 'standard', gear: 2 },
      Ultimate: { icon: 'ultimate', gear: 3 },
      Creative: { icon: 'creative', gear: 'creative' },
    });
    expect(component).toContain(
      'data-harness-density={densityProfile ? HARNESS_PRESENTATION[densityProfile].gear : 0}',
    );
    expect(component).toContain('name={HARNESS_PRESENTATION[profile].icon}');
    expect(component).not.toContain('className="openbitfun-harness-selector__density-core"');
    expect(component).toContain('<HarnessProfileMark profile={id} />');
    expect(component).toContain('<HarnessProfileMark profile={knownSelectedProfile} />');
    expect(component).not.toContain('compact=');
    expect(stylesheet).not.toMatch(/__trigger-value \{[\s\S]*?display: none;/);
  });

  it('uses a text reasoning label in ChatInput while preserving the default meter', () => {
    const component = readLocalFile('ReasoningPresetSelector.tsx');
    const stylesheet = readLocalFile('ReasoningPresetSelector.scss');
    const chatInput = readLocalFile('ChatInput.tsx');

    expect(component).toContain('__status-meter');
    expect(component).toContain("triggerPresentation === 'label'");
    expect(component).toContain('__trigger-label');
    expect(component).toContain('<ReasoningIntensityMark level={intensityLevel} compact />');
    expect(component).toContain('aria-label={tooltip}');
    expect(stylesheet).toMatch(/&__trigger \{[\s\S]*?width: 18px;[\s\S]*?height: 18px;/);
    expect(stylesheet).toMatch(
      /&__trigger-label \{[\s\S]*?font-size: var\(--openbitfun-type-flow-control-font-size\);/,
    );
    expect(chatInput).toContain('reasoningTriggerPresentation="label"');
  });

  it('lifts the permission risk ramp onto the trigger, not just the menu rows', () => {
    const stylesheet = readWorkspaceStripStylesheet();

    const riskRamp = stylesheet.slice(
      stylesheet.indexOf('&__permission-overview-icon {'),
      stylesheet.indexOf('&__permission-label {'),
    );
    expect(riskRamp).toContain('permission-trigger--ask &');
    expect(riskRamp).toContain('var(--openbitfun-color-status-success-emphasis)');
    expect(riskRamp).toContain('permission-trigger--auto &');
    expect(riskRamp).toContain('var(--openbitfun-color-status-warning-emphasis)');
    expect(riskRamp).toContain('permission-trigger--full_access &');
    expect(riskRamp).toContain('var(--openbitfun-color-status-danger-emphasis)');
    // Full access keeps a body of its own so the risk survives the label being
    // dropped on a narrow composer.
    expect(stylesheet).toMatch(
      /&__permission-trigger \{[\s\S]*?&--full_access \{[\s\S]*?background: var\(--openbitfun-color-status-danger-surface\);/,
    );
  });

  it('degrades prose before labels and never drops state color or a number', () => {
    const stylesheet = readWorkspaceStripStylesheet();

    // Labels go on a narrow track…
    expect(stylesheet).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?__permission-label \{\n {6}display: none;/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 460px\)[\s\S]*?__worktree-label \{\n {6}display: none;/,
    );
    // …while the embedded-surface isolation fallback, the permission shield,
    // and the context ring stay.
    expect(stylesheet).not.toMatch(/@media[\s\S]*?__worktree-toggle \{\n {6}display: none;/);
    expect(stylesheet).not.toMatch(/@media[\s\S]*?__usage-ring \{\n {6}display: none;/);
    expect(stylesheet).not.toMatch(/@media[\s\S]*?__permission-overview-icon \{\n {6}display: none;/);
  });

  it('nests worktree isolation in the local target and keeps an embedded fallback', () => {
    const component = readWorkspaceStripComponent();
    const targetPicker = readDispatchTargetPickerComponent();
    const stylesheet = readWorkspaceStripStylesheet();

    // The normal composer offers both local modes in one target menu. A rare
    // embedded surface without that picker retains the standalone switch so
    // it does not lose worktree capability.
    expect(component).toContain('localWorktreeControl={showWorktreeToggle && worktreeControl ? {');
    expect(component).toContain('!showDispatchPicker ? renderWorktreeToggle() : null');
    expect(targetPicker).toContain('data-testid="dispatch-target-local-option"');
    expect(targetPicker).toContain('data-testid="dispatch-target-new-worktree-option"');
    expect(targetPicker).toContain('<strong><OverflowText>{localWorktreeControl.label}</OverflowText></strong>');
    expect(targetPicker).toContain('role="menuitemradio"');
    expect(component).toContain('role="switch"');
    expect(component).toContain('__worktree-toggle');
    expect(component).not.toContain('__chip--branch-toggle');
    expect(stylesheet).toMatch(/&__worktree-toggle \{\n\s*@include strip-control;/);
    // On/off is a colour, not an outline: one bordered item in a borderless
    // row reads as an error state rather than a mode.
    expect(stylesheet).toMatch(
      /&--on \{\n\s*color: var\(--openbitfun-color-accent-default\);/,
    );
    expect(stylesheet).not.toMatch(/&__worktree-toggle \{[\s\S]*?border: 1px/);
  });

  it('removes down chevrons from the clickable workspace and target labels', () => {
    const component = readWorkspaceStripComponent();
    const targetPicker = readDispatchTargetPickerComponent();
    const stylesheet = readWorkspaceStripStylesheet();

    expect(component).not.toContain('ChevronDown');
    expect(component).not.toContain('__workspace-chevron');
    expect(targetPicker).not.toContain('chevron-down');
    expect(targetPicker).not.toContain('__chevron');
    expect(stylesheet).not.toContain('__workspace-chevron');
  });

  it('answers a blocked turn from the composer stack, not from over the transcript', () => {
    const chatInput = readLocalFile('ChatInput.tsx');
    const container = readLocalFile('modern/ModernFlowChatContainer.tsx');
    const band = readLocalFile('ChatInputApprovalBand.scss');

    expect(chatInput).toContain('<ChatInputApprovalBand');
    // The panel used to be positioned by measuring the composer's height, which
    // put it on top of the output the reader needed in order to decide.
    expect(container).not.toContain('PermissionRequestPanel');
    expect(container).not.toContain('permissionPanelAboveChatInput');
    expect(band).not.toContain('position: absolute');
    expect(band).not.toContain('position: fixed');
  });

  it('keeps direct child approvals in the child panel while delegated requests stay with the parent', () => {
    const chatInput = readLocalFile('ChatInput.tsx');
    const childPanel = readLocalFile('btw/BtwSessionPanel.tsx');

    expect(chatInput).toContain('ownedActiveBatch: activePermissionBatch');
    expect(chatInput).toContain('ownedRequests: pendingPermissionRequests');
    expect(chatInput).toContain('usePermissionRequests(currentSessionId || undefined)');
    expect(chatInput).not.toContain(
      'usePermissionRequests(effectiveTargetSessionId || undefined)',
    );
    expect(childPanel).toContain('ownedActiveBatch: activePermissionBatch');
    expect(childPanel).toContain('<ChatInputApprovalBand');
  });

  it('reuses the composer as the rejection reason instead of carrying a second field', () => {
    const band = readLocalFile('ChatInputApprovalBand.tsx');

    expect(band).not.toContain('<textarea');
    expect(band).toContain('rejectReason');
    expect(band).toContain('onRejectReasonConsumed');
    // A half-typed next message must not silently become a reason, so the
    // reason is a separate answer rather than a modifier on rejecting.
    expect(band).toContain('data-testid="chat-input-approval-reject-with-reason"');
    expect(band).toMatch(/reply === 'reject' && withReason && reason/);
  });

  it('keeps the local target breadcrumb visible while Git gates mutating controls', () => {
    const component = readWorkspaceStripComponent();

    expect(component).toContain(
      "import { DispatchTargetPicker } from '@/features/dispatch/DispatchTargetPicker';",
    );
    expect(component).toContain('<DispatchTargetPicker');
    // One Git probe decides both controls, so they can never disagree about
    // whether the workspace is a repository. A repository Git refuses to read
    // for ownership reasons counts: `isRepository` only turns true after a
    // status call that rejection blocks, and hiding the controls there would
    // hide the very state the user has to act on.
    expect(component).toContain(
      'const isGitWorkspace = isRepository || repositoryTrustRequired || isWorktree || worktreeEnabled;',
    );
    expect(component).toContain('const showWorktreeToggle = !!worktreeControl && isGitWorkspace;');
    expect(component).toContain('const showDispatchPicker = !!dispatchControl;');
    expect(component).toContain(
      'const dispatchPickerLocked = !!dispatchControl && (dispatchControl.locked || !isGitWorkspace);',
    );
    expect(component).toContain('locked={dispatchPickerLocked}');
    expect(component).toContain('localWorktreeControl={showWorktreeToggle && worktreeControl ? {');
  });
});
