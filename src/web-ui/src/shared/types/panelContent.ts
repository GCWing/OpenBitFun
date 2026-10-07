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
  | 'thinking-detail'
  | 'background-command-output'
  | 'review-platform'
  | 'review-platform-pr-detail'
  | 'terminal'
  | 'generative-widget'
  | 'openbitfun-canvas'
  | 'browser'
  | 'html-preview';

export interface PanelContent {
  type: PanelContentType;
  title: string;
  data?: any;
  metadata?: Record<string, any>;
}
