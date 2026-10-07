/**
 * Utility functions for panel content type configuration and management.
 * Provides helpers for icon resolution, capability checking, and file generation.
 */

import React from 'react';
import { Icon } from '@openbitfun/ui';
import { 
  Code, 
  FileText, 
  BookOpen,
  ClipboardList,
  Network,
  MessageSquareQuote,
  Activity,
  GitPullRequest,
} from 'lucide-react';
import { PanelContentType, PanelContentConfig } from './types';

// Configuration mapping for each panel content type
export const PANEL_CONTENT_CONFIGS: Record<PanelContentType, PanelContentConfig> = {
  'empty': {
    type: 'empty',
    displayName: 'Empty',
    icon: { glyph: FileText },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'code-preview': {
    type: 'code-preview',
    displayName: 'Code Preview',
    icon: { glyph: Code },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: true
  },
  'code-viewer': {
    type: 'code-viewer',
    displayName: 'Code Viewer',
    icon: { glyph: Code },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: false
  },
  'code-editor': {
    type: 'code-editor',
    displayName: 'Code Editor',
    icon: { glyph: Code },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: false
  },
  'markdown-viewer': {
    type: 'markdown-viewer',
    displayName: 'Markdown Viewer',
    icon: { glyph: FileText },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: true
  },
  'markdown-editor': {
    type: 'markdown-editor',
    displayName: 'Markdown Editor',
    icon: { glyph: FileText },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: false
  },
  'text-viewer': {
    type: 'text-viewer',
    displayName: 'Text Viewer',
    icon: { name: 'eye' },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: true
  },
  'file-viewer': {
    type: 'file-viewer',
    displayName: 'File Viewer',
    icon: { glyph: Code },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: false
  },
  'image-viewer': {
    type: 'image-viewer',
    displayName: 'Image Viewer',
    icon: { name: 'image' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'pdf-viewer': {
    type: 'pdf-viewer',
    displayName: 'PDF Viewer',
    icon: { glyph: FileText },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'html-preview': {
    type: 'html-preview',
    displayName: 'HTML Preview',
    icon: { name: 'browser' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'diff-code-editor': {
    type: 'diff-code-editor',
    displayName: 'Diff Editor',
    icon: { glyph: Code },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: false
  },
  'git-diff': {
    type: 'git-diff',
    displayName: 'Git Diff',
    icon: { name: 'git' },
    supportsCopy: true,
    supportsDownload: true,
    showHeader: false
  },
  'git-settings': {
    type: 'git-settings',
    displayName: 'Git Settings',
    icon: { name: 'git' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'git-graph': {
    type: 'git-graph',
    displayName: 'Git Graph',
    icon: { name: 'git' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'git-branch-history': {
    type: 'git-branch-history',
    displayName: 'Git Branch History',
    icon: { name: 'git' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'ai-session': {
    type: 'ai-session',
    displayName: 'AI Session',
    icon: { glyph: BookOpen },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'planner': {
    type: 'planner',
    displayName: 'Planner',
    icon: { glyph: ClipboardList },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'ui-editor': {
    type: 'ui-editor',
    displayName: 'UI Editor',
    icon: { name: 'edit' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'ui-relation-graph': {
    type: 'ui-relation-graph',
    displayName: 'UI Relation Graph',
    icon: { glyph: Network },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'design-tokens': {
    type: 'design-tokens',
    displayName: 'Design Tokens',
    icon: { name: 'settings' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'task-detail': {
    type: 'task-detail',
    displayName: 'Task Detail',
    icon: { glyph: ClipboardList },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'plan-viewer': {
    type: 'plan-viewer',
    displayName: 'Plan Viewer',
    icon: { glyph: ClipboardList },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'btw-session': {
    type: 'btw-session',
    displayName: 'Side Session',
    icon: { glyph: MessageSquareQuote },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'thinking-detail': {
    type: 'thinking-detail',
    displayName: 'Thinking',
    icon: { name: 'thinking' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'session-usage': {
    type: 'session-usage',
    displayName: 'Session Usage',
    icon: { glyph: Activity },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'background-command-output': {
    type: 'background-command-output',
    displayName: 'Command Output',
    icon: { name: 'terminal' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'review-platform': {
    type: 'review-platform',
    displayName: 'Pull Requests',
    icon: { glyph: GitPullRequest },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'review-platform-pr-detail': {
    type: 'review-platform-pr-detail',
    displayName: 'Pull Request',
    icon: { glyph: GitPullRequest },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'terminal': {
    type: 'terminal',
    displayName: 'Terminal',
    icon: { glyph: Code },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'generative-widget': {
    type: 'generative-widget',
    displayName: 'Widget Preview',
    icon: { glyph: Network },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'openbitfun-canvas': {
    type: 'openbitfun-canvas',
    displayName: 'OpenBitFun Canvas',
    icon: { glyph: Network },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
  'browser': {
    type: 'browser',
    displayName: 'Browser',
    icon: { name: 'browser' },
    supportsCopy: false,
    supportsDownload: false,
    showHeader: false
  },
};

/**
 * Gets the icon component for a given panel content type.
 * 
 * @param type - The panel content type
 * @returns React element with the appropriate icon (size: 16px)
 */
export const getContentIcon = (type: PanelContentType): React.ReactElement => {
  if (!type || !PANEL_CONTENT_CONFIGS[type]) {
    return React.createElement(Icon, { ...PANEL_CONTENT_CONFIGS.empty.icon, size: 'md' });
  }
  const config = PANEL_CONTENT_CONFIGS[type];
  return React.createElement(Icon, { ...config.icon, size: 'md' });
};

/**
 * Gets the display name for a given panel content type.
 * 
 * @param type - The panel content type
 * @returns Human-readable display name
 */
export const getContentTypeName = (type: PanelContentType): string => {
  if (!type || !PANEL_CONTENT_CONFIGS[type]) {
    return PANEL_CONTENT_CONFIGS.empty.displayName;
  }
  return PANEL_CONTENT_CONFIGS[type].displayName;
};

/**
 * Checks whether a content type supports copy functionality.
 * 
 * @param type - The panel content type
 * @returns True if the content type supports copying
 */
export const supportsContentCopy = (type: PanelContentType): boolean => {
  if (!type || !PANEL_CONTENT_CONFIGS[type]) {
    return false;
  }
  return PANEL_CONTENT_CONFIGS[type].supportsCopy;
};

/**
 * Checks whether a content type supports download functionality.
 * 
 * @param type - The panel content type
 * @returns True if the content type supports downloading
 */
export const supportsContentDownload = (type: PanelContentType): boolean => {
  if (!type || !PANEL_CONTENT_CONFIGS[type]) {
    return false;
  }
  return PANEL_CONTENT_CONFIGS[type].supportsDownload;
};

/**
 * Checks whether a content type should display a panel header.
 * 
 * @param type - The panel content type
 * @returns True if the content type should show the default header
 */
export const shouldShowHeader = (type: PanelContentType): boolean => {
  if (!type || !PANEL_CONTENT_CONFIGS[type]) {
    return false;
  }
  return PANEL_CONTENT_CONFIGS[type].showHeader;
};

/**
 * Generates a unique identifier for a panel tab.
 * 
 * @returns Unique tab ID in the format "tab_{timestamp}_{random}"
 */
export const generateTabId = (): string => {
  return `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Generates an appropriate filename based on content type and title.
 * 
 * @param type - The panel content type
 * @param title - The content title (used as base filename)
 * @returns Filename with appropriate extension for the content type
 */
export const generateFileName = (type: PanelContentType, title: string): string => {
  const baseName = title || 'content';
  
  switch (type) {
    case 'markdown-viewer':
    case 'markdown-editor':
      return `${baseName}.md`;
    case 'code-preview':
      return `${baseName}.txt`;
    default:
      return `${baseName}.txt`;
  }
};
