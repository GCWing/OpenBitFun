/** Status bar for cursor position, language, and encoding. */

import React from 'react';
import { DEFAULT_EDITOR_CONFIG } from '../config/defaults';

import { useI18n } from '@/infrastructure/i18n';
import './EditorStatusBar.scss';
import { Tooltip } from '@openbitfun/ui';

export interface EditorStatusBarProps {
  /** Current line number */
  line: number;
  /** Current column number */
  column: number;
  /** Number of selected characters */
  selectedChars?: number;
  /** Number of selected lines */
  selectedLines?: number;
  /** Programming language */
  language: string;
  /** File encoding */
  encoding?: string;
  /** Tab size */
  tabSize?: number;
  /** Whether to use spaces instead of tabs */
  insertSpaces?: boolean;
  /** Whether file has unsaved changes (reserved for extension) */
  hasChanges?: boolean;
  /** Whether file is being saved (reserved for extension) */
  isSaving?: boolean;
  /** Whether file is read-only */
  isReadOnly?: boolean;
  /** Language click callback */
  onLanguageClick?: (e: React.MouseEvent) => void;
  /** Encoding click callback */
  onEncodingClick?: (e: React.MouseEvent) => void;
  /** Indent click callback */
  onIndentClick?: (e: React.MouseEvent) => void;
  /** Position click callback */
  onPositionClick?: (e: React.MouseEvent) => void;
}

/** Get friendly display name for language */
const getLanguageDisplayName = (language: string): string => {
  const languageMap: Record<string, string> = {
    'typescript': 'TypeScript',
    'javascript': 'JavaScript',
    'typescriptreact': 'TypeScript React',
    'javascriptreact': 'JavaScript React',
    'python': 'Python',
    'rust': 'Rust',
    'go': 'Go',
    'java': 'Java',
    'csharp': 'C#',
    'cpp': 'C++',
    'c': 'C',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'less': 'Less',
    'json': 'JSON',
    'yaml': 'YAML',
    'xml': 'XML',
    'markdown': 'Markdown',
    'sql': 'SQL',
    'shell': 'Shell',
    'bash': 'Bash',
    'powershell': 'PowerShell',
    'dockerfile': 'Dockerfile',
    'plaintext': 'Plain Text',
    'toml': 'TOML',
    'cangjie': 'Cangjie',
    'ini': 'INI',
    'vue': 'Vue',
    'svelte': 'Svelte',
    'graphql': 'GraphQL',
    'php': 'PHP',
    'ruby': 'Ruby',
    'swift': 'Swift',
    'kotlin': 'Kotlin',
    'scala': 'Scala',
    'lua': 'Lua',
    'perl': 'Perl',
    'r': 'R',
  };
  return languageMap[language.toLowerCase()] || language;
};

export const EditorStatusBar: React.FC<EditorStatusBarProps> = ({
  line,
  column,
  selectedChars = 0,
  selectedLines = 0,
  language,
  encoding = 'UTF-8',
  tabSize = DEFAULT_EDITOR_CONFIG.tabSize,
  insertSpaces = true,
  isReadOnly = false,
  onLanguageClick,
  onEncodingClick,
  onIndentClick,
  onPositionClick,
}) => {
  const { t } = useI18n('tools');

  // Build selection info text (updates with language changes).
  const getSelectionText = () => {
    if (selectedLines > 1) {
      return `(${t('editor.statusBar.selectionLinesChars', { lines: selectedLines, chars: selectedChars })})`;
    }
    if (selectedChars > 0) {
      return `(${t('editor.statusBar.selectionChars', { count: selectedChars })})`;
    }
    return '';
  };

  return (
    <div className="editor-status-bar" data-openbitfun-component="editor-status-bar" data-openbitfun-part="root">
      <div data-openbitfun-component="editor-status-bar" data-openbitfun-part="left" className="editor-status-bar__left">
        {isReadOnly && (
          <div data-openbitfun-component="editor-status-bar" data-openbitfun-part="item" className="editor-status-bar__item editor-status-bar__readonly">
            {t('editor.statusBar.readOnly')}
          </div>
        )}
      </div>

      <div data-openbitfun-component="editor-status-bar" data-openbitfun-part="right" className="editor-status-bar__right">
        <Tooltip content={t('editor.statusBar.goToLine')} placement="top">
          <div 
            data-openbitfun-component="editor-status-bar"
            data-openbitfun-part="item"
            className={`editor-status-bar__item ${onPositionClick ? 'editor-status-bar__item--clickable' : ''}`}
            onClick={onPositionClick}
          >
            <span>{t('editor.statusBar.ln')} {line}, {t('editor.statusBar.col')} {column}</span>
            {getSelectionText() && (
              <span data-openbitfun-component="editor-status-bar" data-openbitfun-part="selection" className="editor-status-bar__selection">{getSelectionText()}</span>
            )}
          </div>
        </Tooltip>

        <div data-openbitfun-component="editor-status-bar" data-openbitfun-part="separator" className="editor-status-bar__separator" />

        <Tooltip content={t('editor.statusBar.indentSettings')} placement="top">
          <div 
            data-openbitfun-component="editor-status-bar"
            data-openbitfun-part="item"
            className={`editor-status-bar__item ${onIndentClick ? 'editor-status-bar__item--clickable' : ''}`}
            onClick={onIndentClick}
          >
            {insertSpaces ? t('editor.statusBar.indentSpaces', { n: tabSize }) : t('editor.statusBar.indentTab', { n: tabSize })}
          </div>
        </Tooltip>

        <div data-openbitfun-component="editor-status-bar" data-openbitfun-part="separator" className="editor-status-bar__separator" />

        <Tooltip content={t('editor.statusBar.fileEncoding')} placement="top">
          <div 
            data-openbitfun-component="editor-status-bar"
            data-openbitfun-part="item"
            className={`editor-status-bar__item ${onEncodingClick ? 'editor-status-bar__item--clickable' : ''}`}
            onClick={onEncodingClick}
          >
            {encoding}
          </div>
        </Tooltip>

        <div data-openbitfun-component="editor-status-bar" data-openbitfun-part="separator" className="editor-status-bar__separator" />

        <Tooltip content={t('editor.statusBar.selectLanguageMode')} placement="top">
          <div 
            data-openbitfun-component="editor-status-bar"
            data-openbitfun-part="item"
            className={`editor-status-bar__item ${onLanguageClick ? 'editor-status-bar__item--clickable' : ''}`}
            onClick={onLanguageClick}
          >
            {getLanguageDisplayName(language)}
          </div>
        </Tooltip>

      </div>
    </div>
  );
};

export default EditorStatusBar;
