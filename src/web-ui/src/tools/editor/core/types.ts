/**
 * Core layer type definitions.
 */

import type * as monaco from 'monaco-editor';
import type { EditorPresetName, EditorConfigPartial } from '../config/types';

export interface MonacoEditorCoreProps {
  /** File path for model management */
  filePath: string;
  workspacePath?: string;
  language?: string;
  /** Initial content (only used on first creation) */
  initialContent?: string;
  
  // Config
  preset?: EditorPresetName;
  config?: EditorConfigPartial;
  readOnly?: boolean;
  
  // Features
  showLineNumbers?: boolean;
  showMinimap?: boolean;
  
  // Event callbacks
  onContentChange?: (content: string, event: monaco.editor.IModelContentChangedEvent) => void;
  onCursorChange?: (position: monaco.Position) => void;
  onSelectionChange?: (selection: monaco.Selection) => void;
  onEditorReady?: (editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) => void;
  onEditorWillDispose?: () => void;
  /** Ctrl+S callback */
  onSave?: (content: string) => void;
  
  // Other
  className?: string;
  style?: React.CSSProperties;
  /** Defer editor instantiation until the container intersects the viewport */
  lazy?: boolean;
  /** @deprecated Use jumpToRange */
  jumpToLine?: number;
  /** @deprecated Use jumpToRange */
  jumpToColumn?: number;
  jumpToRange?: import('@/shared/editor/LineRange').LineRange;
}

export interface MonacoDiffCoreProps {
  originalContent: string;
  modifiedContent: string;
  filePath?: string;
  workspacePath?: string;
  language?: string;
  
  // Config
  preset?: EditorPresetName;
  config?: EditorConfigPartial;
  /** ReadOnly for modified editor */
  readOnly?: boolean;
  
  // Diff specific
  /** Side-by-side (false = inline) */
  renderSideBySide?: boolean;
  renderOverviewRuler?: boolean;
  renderIndicators?: boolean;
  originalEditable?: boolean;
  ignoreTrimWhitespace?: boolean;
  
  // Features
  showMinimap?: boolean;
  
  // Event callbacks
  onModifiedContentChange?: (content: string) => void;
  onDiffChange?: (changes: monaco.editor.ILineChange[]) => void;
  onEditorReady?: (
    diffEditor: monaco.editor.IStandaloneDiffEditor,
    originalModel: monaco.editor.ITextModel,
    modifiedModel: monaco.editor.ITextModel
  ) => void;
  onEditorWillDispose?: () => void;
  
  // Other
  className?: string;
  style?: React.CSSProperties;
  /** Reveal line in modified (1-based) */
  revealLine?: number;
}

export interface EditorReadyState {
  isReady: boolean;
  editor: monaco.editor.IStandaloneCodeEditor | null;
  model: monaco.editor.ITextModel | null;
}

export interface DiffEditorReadyState {
  isReady: boolean;
  diffEditor: monaco.editor.IStandaloneDiffEditor | null;
  originalModel: monaco.editor.ITextModel | null;
  modifiedModel: monaco.editor.ITextModel | null;
  originalEditor: monaco.editor.IStandaloneCodeEditor | null;
  modifiedEditor: monaco.editor.IStandaloneCodeEditor | null;
}
