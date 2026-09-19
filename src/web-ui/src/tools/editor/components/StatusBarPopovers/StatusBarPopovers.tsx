/**
 * Status bar popovers: go to line, indent, encoding, language mode.
 * Styled to match Cursor/VS Code popover interactions.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import {
  FileCode,
  FileText,
  Braces,
  Code2,
  Code,
  FileJson,
  type LucideIcon,
} from 'lucide-react';

import { useI18n } from '@/infrastructure/i18n';
import './StatusBarPopovers.scss';
import { createOverlayPortal, Input, Listbox, ListboxOption } from '@openbitfun/ui';

export type StatusBarPopoverType = 'position' | 'indent' | 'encoding' | 'language';

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GoToLinePopoverProps {
  anchorRect: AnchorRect;
  currentLine: number;
  currentColumn: number;
  onConfirm: (line: number, column: number) => void;
  onClose: () => void;
}

export const GoToLinePopover: React.FC<GoToLinePopoverProps> = ({
  anchorRect,
  currentLine,
  currentColumn,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n('tools');
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(`${currentLine}:${currentColumn}`);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, [currentLine, currentColumn]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) {
        onClose();
        return;
      }
      const part = trimmed.split(':');
      const line = Math.max(1, parseInt(part[0], 10) || 1);
      const column = part[1] !== undefined ? Math.max(1, parseInt(part[1], 10) || 1) : 1;
      onConfirm(line, column);
      onClose();
    }
  };

  const top = anchorRect.top - 4;
  const left = Math.max(8, Math.min(anchorRect.right - 200, anchorRect.left));

  return createOverlayPortal(
    <div
      className="status-bar-popover"
      data-openbitfun-component="status-bar-popover"
      data-openbitfun-part="root"
      data-openbitfun-popover="line"
      style={{ top, left }}
      role="dialog"
      aria-label={t('editor.statusBar.goToLine')}
    >
      <div data-openbitfun-component="status-bar-popover" data-openbitfun-part="hint" className="status-bar-popover__hint">{t('editor.statusBar.goToLineHint')}</div>
      <div data-openbitfun-component="status-bar-popover" data-openbitfun-part="inputWrap" className="status-bar-popover__input-wrap">
        <Input
          data-openbitfun-component="status-bar-popover"
          data-openbitfun-part="input"
          ref={inputRef}
          type="text"
          className="status-bar-popover__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('editor.statusBar.goToLinePlaceholder')}
          size="sm"
        />
      </div>
    </div>,
    getAppearanceOverlayHost()
  );
};

export interface IndentOption {
  label: string;
  tabSize: number;
  insertSpaces: boolean;
}

const INDENT_OPTIONS = [true, false].flatMap(insertSpaces =>
  Array.from({ length: 8 }, (_, index) => ({ tabSize: index + 1, insertSpaces }))
);

export interface IndentPopoverProps {
  anchorRect: AnchorRect;
  currentTabSize: number;
  currentInsertSpaces: boolean;
  onConfirm: (tabSize: number, insertSpaces: boolean) => void;
  onClose: () => void;
}

export const IndentPopover: React.FC<IndentPopoverProps> = ({
  anchorRect,
  currentTabSize,
  currentInsertSpaces,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n('tools');
  const handleSelect = useCallback(
    (opt: { tabSize: number; insertSpaces: boolean }) => {
      onConfirm(opt.tabSize, opt.insertSpaces);
      onClose();
    },
    [onConfirm, onClose]
  );

  const top = anchorRect.top - 4;
  const left = Math.max(8, Math.min(anchorRect.right - 160, anchorRect.left));

  return createOverlayPortal(
    <div
      className="status-bar-popover"
      data-openbitfun-component="status-bar-popover"
      data-openbitfun-part="root"
      data-openbitfun-popover="indent"
      style={{ top, left }}
      role="dialog"
      aria-label={t('editor.statusBar.indentSettings')}
    >
      <div data-openbitfun-component="status-bar-popover" data-openbitfun-part="hint" className="status-bar-popover__hint">{t('editor.statusBar.selectIndent')}</div>
      <Listbox
        autoFocusOption
        aria-label={t('editor.statusBar.selectIndent')}
        className="status-bar-popover__list"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        {INDENT_OPTIONS.map((opt) => {
          const label = opt.insertSpaces
            ? t('editor.statusBar.indentOptionSpaces', { n: opt.tabSize })
            : t('editor.statusBar.indentOptionTab', { n: opt.tabSize });
          const selected = opt.tabSize === currentTabSize
            && opt.insertSpaces === currentInsertSpaces;
          return (
            <ListboxOption
              key={`${opt.insertSpaces ? 's' : 't'}-${opt.tabSize}`}
              onClick={() => handleSelect(opt)}
              selected={selected}
              value={`${opt.insertSpaces ? 'spaces' : 'tabs'}-${opt.tabSize}`}
            >
              {label}
            </ListboxOption>
          );
        })}
      </Listbox>
    </div>,
    getAppearanceOverlayHost()
  );
};

const ENCODING_OPTIONS = ['UTF-8', 'UTF-8 with BOM', 'GBK', 'GB2312', 'UTF-16LE', 'UTF-16BE', 'ISO-8859-1'];

export interface EncodingPopoverProps {
  anchorRect: AnchorRect;
  currentEncoding: string;
  onConfirm: (encoding: string) => void;
  onClose: () => void;
}

export const EncodingPopover: React.FC<EncodingPopoverProps> = ({
  anchorRect,
  currentEncoding,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n('tools');
  const top = anchorRect.top - 4;
  const left = Math.max(8, Math.min(anchorRect.right - 160, anchorRect.left));

  return createOverlayPortal(
    <div
      className="status-bar-popover"
      data-openbitfun-component="status-bar-popover"
      data-openbitfun-part="root"
      data-openbitfun-popover="encoding"
      style={{ top, left }}
      role="dialog"
      aria-label={t('editor.statusBar.fileEncoding')}
    >
      <div data-openbitfun-component="status-bar-popover" data-openbitfun-part="hint" className="status-bar-popover__hint">{t('editor.statusBar.selectEncoding')}</div>
      <Listbox
        autoFocusOption
        aria-label={t('editor.statusBar.selectEncoding')}
        className="status-bar-popover__list"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        {ENCODING_OPTIONS.map((enc) => (
          <ListboxOption
            key={enc}
            onClick={() => {
              onConfirm(enc);
              onClose();
            }}
            selected={enc === currentEncoding}
            value={enc}
          >
            {enc}
          </ListboxOption>
        ))}
      </Listbox>
    </div>,
    getAppearanceOverlayHost()
  );
};

// Language mode (with Cursor-style small icons)
const getLanguageDisplayName = (id: string, aliases?: string[]): string => {
  const map: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    typescriptreact: 'TypeScript React',
    javascriptreact: 'JavaScript React',
    python: 'Python',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    csharp: 'C#',
    cpp: 'C++',
    c: 'C',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    less: 'Less',
    json: 'JSON',
    yaml: 'YAML',
    xml: 'XML',
    markdown: 'Markdown',
    sql: 'SQL',
    shell: 'Shell',
    bash: 'Bash',
    plaintext: 'Plain Text',
    toml: 'TOML',
    vue: 'Vue',
    svelte: 'Svelte',
    graphql: 'GraphQL',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    lua: 'Lua',
  };
  return map[id.toLowerCase()] || (aliases?.[0] ?? id);
};

const getLanguageIcon = (id: string): LucideIcon => {
  const key = id.toLowerCase();
  if (key === 'json' || key === 'jsonc') return Braces;
  if (key === 'markdown' || key === 'md') return FileText;
  if (key === 'html' || key === 'xml') return FileCode;
  if (key === 'plaintext' || key === 'txt') return FileText;
  if (key === 'typescript' || key === 'typescriptreact' || key === 'javascript' || key === 'javascriptreact') return Code2;
  if (key === 'python' || key === 'rust' || key === 'go' || key === 'java' || key === 'csharp' || key === 'cpp' || key === 'c') return Code;
  if (key === 'css' || key === 'scss' || key === 'less') return FileCode;
  if (key === 'yaml' || key === 'yml' || key === 'toml') return FileCode;
  if (key === 'sql' || key === 'shell' || key === 'bash') return FileCode;
  if (key === 'vue' || key === 'svelte' || key === 'graphql') return FileJson;
  return FileCode;
};

export interface LanguagePopoverProps {
  anchorRect: AnchorRect;
  currentLanguageId: string;
  languages: Array<{ id: string; aliases?: string[] }>;
  onConfirm: (languageId: string) => void;
  onClose: () => void;
}

export const LanguagePopover: React.FC<LanguagePopoverProps> = ({
  anchorRect,
  currentLanguageId,
  languages,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n('tools');
  const top = anchorRect.top - 4;
  const left = Math.max(8, Math.min(anchorRect.right - 180, anchorRect.left));

  return createOverlayPortal(
    <div
      className="status-bar-popover"
      data-openbitfun-component="status-bar-popover"
      data-openbitfun-part="root"
      data-openbitfun-popover="language"
      style={{ top, left, maxHeight: 320 }}
      role="dialog"
      aria-label={t('editor.statusBar.selectLanguageMode')}
    >
      <div data-openbitfun-component="status-bar-popover" data-openbitfun-part="hint" className="status-bar-popover__hint">{t('editor.statusBar.selectLanguageModeHint')}</div>
      <Listbox
        autoFocusOption
        aria-label={t('editor.statusBar.selectLanguageModeHint')}
        className="status-bar-popover__list"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        {languages.map((lang) => {
          const Icon = getLanguageIcon(lang.id);
          return (
            <ListboxOption
              key={lang.id}
              leading={<Icon size={14} strokeWidth={2} />}
              onClick={() => {
                onConfirm(lang.id);
                onClose();
              }}
              selected={lang.id === currentLanguageId}
              value={lang.id}
            >
              {getLanguageDisplayName(lang.id, lang.aliases)}
            </ListboxOption>
          );
        })}
      </Listbox>
    </div>,
    getAppearanceOverlayHost()
  );
};
