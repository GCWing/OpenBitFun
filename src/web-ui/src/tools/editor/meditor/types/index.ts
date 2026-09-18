import { CSSProperties, ReactNode } from 'react'

/**
 * Editor mode
 */
export type EditorMode = 'ir' | 'edit'

/**
 * Toolbar button configuration
 */
export interface ToolbarButton {
  name: string
  icon?: string | ReactNode
  title?: string
  hotkey?: string
  action: (editor: EditorInstance) => void
}

/**
 * Toolbar configuration
 */
export interface ToolbarConfig {
  buttons?: string[] | ToolbarButton[]
  customButtons?: ToolbarButton[]
}

/**
 * Plugin interface
 */
export interface Plugin {
  name: string
  initialize: (editor: EditorInstance) => void
  destroy?: () => void
}

/**
 * Upload configuration
 */
export interface UploadConfig {
  url?: string
  max?: number
  accept?: string
  multiple?: boolean
  handler?: (files: File[]) => Promise<string[]>
}

/**
 * Editor options
 */
export interface EditorOptions {
  value?: string
  defaultValue?: string
  height?: string | number
  width?: string | number
  mode?: EditorMode
  toolbar?: boolean | ToolbarConfig
  outline?: boolean
  counter?: boolean
  plugins?: Plugin[]
  upload?: UploadConfig
  placeholder?: string
  readonly?: boolean
  autofocus?: boolean
  onChange?: (value: string) => void
  onSave?: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
  onSelect?: (value: string) => void
  /**
   * Dirty state change callback.
   * Called when dirty state (unsaved changes) changes.
   */
  onDirtyChange?: (isDirty: boolean) => void
  className?: string
  style?: CSSProperties
  /**
   * Absolute path of the Markdown document.
   * Used by AI prompt builders and path-aware features.
   */
  filePath?: string
  /**
   * Directory path of the Markdown file.
   * Used to resolve relative image paths.
   */
  basePath?: string
}

/**
 * Editor instance interface
 */
export interface EditorInstance {
  getValue: () => string
  setValue: (value: string) => void
  insertValue: (value: string, start?: number, end?: number) => void
  focus: () => void
  blur: () => void
  setMode: (mode: EditorMode) => void
  getSelection: () => { start: number; end: number; text: string }
  destroy: () => void
  /** Scroll to specific line */
  scrollToLine?: (line: number, highlight?: boolean) => void
  /** Undo */
  undo?: () => boolean
  /** Redo */
  redo?: () => boolean
  /** Whether undo is available */
  canUndo?: boolean
  /** Whether redo is available */
  canRedo?: boolean
  /** Mark current state as saved */
  markSaved?: () => void
  /** Set initial content (used for file loading) */
  setInitialContent?: (content: string) => void
  /** Whether there are unsaved changes */
  isDirty?: boolean
}
