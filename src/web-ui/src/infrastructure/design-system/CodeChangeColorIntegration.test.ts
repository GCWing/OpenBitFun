import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CODE_CHANGE_TOKENS = [
  '--openbitfun-color-code-change-added',
  '--openbitfun-color-code-change-removed',
] as const;

const PRIMARY_CODE_CHANGE_SURFACES = [
  '../../flow_chat/components/modern/SessionFilesBadge.scss',
  '../../flow_chat/components/modern/SessionFileModificationsBar.scss',
  '../../flow_chat/components/usage/SessionUsageReportCard.scss',
  '../../flow_chat/tool-cards/SnapshotFullscreenDiffViewer.css',
  '../../tools/editor/components/DiffEditor.scss',
  '../../tools/git/components/BranchQuickSwitch.scss',
  '../../tools/git/components/GitDiffView/GitDiffView.scss',
  '../../tools/openbitfun-canvas/runtime/sdk/data-display.tsx',
  '../../tools/openbitfun-canvas/runtime/canvasRuntimeInstaller.ts',
  '../../tools/openbitfun-canvas/runtime/styles/canvas-runtime.scss',
  '../../app/components/panels/review-platform/ReviewPlatformPanel.scss',
] as const;

describe('code-change color integration', () => {
  it('uses the shared addition and removal semantics across product surfaces', () => {
    for (const relativePath of PRIMARY_CODE_CHANGE_SURFACES) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');

      for (const token of CODE_CHANGE_TOKENS) {
        expect(source, `${relativePath} should consume ${token}`).toContain(token);
      }
    }
  });

  it('keeps diff renderers independent from the appearance-specific Git palette', () => {
    for (const relativePath of [
      '../../flow_chat/components/InlineDiffPreview.scss',
      '../../tools/editor/components/DiffEditor.scss',
      '../../tools/git/components/GitDiffView/GitDiffView.scss',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');

      expect(source).not.toMatch(/--openbitfun-domain-git-(?:added|deleted|staged)/);
    }
  });

  it('uses dedicated diff colors for the inline code viewer', () => {
    const source = readFileSync(new URL('../../flow_chat/components/InlineDiffPreview.scss', import.meta.url), 'utf8');
    expect(source).toContain('--openbitfun-color-code-diff-added-marker');
    expect(source).toContain('--openbitfun-color-code-diff-removed-marker');
  });
});
