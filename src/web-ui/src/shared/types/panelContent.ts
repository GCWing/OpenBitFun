export type PanelContentType =
  | 'empty'
  | 'code-preview'
  | 'code-viewer'
  | 'code-editor'
  | 'markdown-viewer'
  | 'markdown-editor'
  | 'text-viewer'
  | 'file-viewer'
  | 'image-viewer'
  | 'pdf-viewer'
  | 'diff-code-editor'
  | 'git-diff'
  | 'git-settings'
  | 'git-graph'
  | 'git-branch-history'
  | 'ai-session'
  | 'planner'
  | 'ui-editor'
  | 'ui-relation-graph'
  | 'design-tokens'
  | 'task-detail'
  | 'plan-viewer'
  | 'btw-session'
  | 'session-usage'
  | 'session-trajectory'
  | 'tool-definitions'
  | 'thinking-detail'
  | 'background-command-output'
  | 'review-platform'
  | 'review-platform-pr-detail'
  | 'terminal'
  | 'generative-widget'
  | 'browser'
  | 'html-preview';

export interface PanelContent {
  type: PanelContentType;
  title: string;
  data?: any;
  metadata?: Record<string, any>;
}

/** Only explicit Harmony delivery widgets are eligible for workbench content. */
export function isHarmonyGenerativeWidgetContent(content: PanelContent): boolean {
  if (content.type !== 'generative-widget') return true;
  const app = content.data?.app;
  return (typeof app?.libraryId === 'string' && app.libraryId.includes('.harmony.'))
    || (typeof app?.template === 'string' && app.template.includes('.harmony.'));
}
