export { MEditor } from './components/MEditor'
export type { MEditorProps } from './components/MEditor'

export { EditArea } from './components/EditArea'
export { TiptapEditor } from './components/TiptapEditor'
export type { TiptapEditorHandle } from './components/TiptapEditor'

// Hooks
export { useEditor } from './hooks/useEditor'
export { useEditorHistory } from './hooks/useEditorHistory'
export type { UseEditorHistoryOptions, UseEditorHistoryReturn } from './hooks/useEditorHistory'

export * from './utils/keyboardShortcuts'
export * from './utils/tiptapMarkdown'

export type {
  EditorMode,
  EditorOptions,
  EditorInstance,
  ToolbarButton,
  ToolbarConfig,
  Plugin,
  UploadConfig
} from './types'
