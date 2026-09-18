import React, {
  Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ErrorInfo,
  type ForwardedRef,
  type ReactNode,
} from 'react'
import { createLogger } from '@/shared/utils/logger'
import { activeEditTargetService } from '@/tools/editor/services/ActiveEditTargetService'
import { useEditor } from '../hooks/useEditor'
import { EditArea } from './EditArea'
import { TiptapEditor, TiptapEditorHandle } from './TiptapEditor'
import type { EditorOptions, EditorInstance } from '../types'
import { useI18n } from '@/infrastructure/i18n'
import './MEditor.scss'

const log = createLogger('MEditor')
let markdownTextareaTargetCounter = 0

export type MEditorProps = EditorOptions;

function executeTextareaAction(
  textarea: HTMLTextAreaElement | null,
  action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll',
): boolean {
  if (!textarea || textarea.disabled) {
    return false
  }

  textarea.focus()

  if (textarea.readOnly && action !== 'copy' && action !== 'selectAll') {
    return false
  }

  if (action === 'selectAll') {
    textarea.select()
    return true
  }

  return document.execCommand(action)
}

const MEditorSourceFallback = forwardRef<EditorInstance, MEditorProps>((props, ref) => {
  const { t } = useI18n('tools')
  const {
    value: controlledValue,
    defaultValue = '',
    height = '500px',
    width = '100%',
    readonly = false,
    autofocus = false,
    placeholder,
    onChange,
    onSave,
    onFocus,
    onBlur,
    onDirtyChange,
    className = '',
    style = {},
  } = props
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const savedValueRef = useRef(controlledValue ?? defaultValue)
  const currentValue = controlledValue ?? uncontrolledValue
  const currentValueRef = useRef(currentValue)
  currentValueRef.current = currentValue

  const updateValue = useCallback((nextValue: string) => {
    currentValueRef.current = nextValue
    if (controlledValue === undefined) {
      setUncontrolledValue(nextValue)
    }
    onChange?.(nextValue)
    onDirtyChange?.(nextValue !== savedValueRef.current)
  }, [controlledValue, onChange, onDirtyChange])

  useImperativeHandle(ref, () => ({
    getValue: () => currentValueRef.current,
    setValue: updateValue,
    insertValue: (nextValue: string, start?: number, end?: number) => {
      const selectionStart = start ?? textareaRef.current?.selectionStart ?? currentValueRef.current.length
      const selectionEnd = end ?? textareaRef.current?.selectionEnd ?? selectionStart
      updateValue(
        currentValueRef.current.slice(0, selectionStart) +
          nextValue +
          currentValueRef.current.slice(selectionEnd)
      )
    },
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
    setMode: () => undefined,
    getSelection: () => {
      const start = textareaRef.current?.selectionStart ?? 0
      const end = textareaRef.current?.selectionEnd ?? start
      return { start, end, text: currentValueRef.current.slice(start, end) }
    },
    destroy: () => undefined,
    undo: () => executeTextareaAction(textareaRef.current, 'undo'),
    redo: () => executeTextareaAction(textareaRef.current, 'redo'),
    canUndo: false,
    canRedo: false,
    markSaved: () => {
      savedValueRef.current = currentValueRef.current
      onDirtyChange?.(false)
    },
    setInitialContent: (content: string) => {
      savedValueRef.current = content
      updateValue(content)
      onDirtyChange?.(false)
    },
    get isDirty() {
      return currentValueRef.current !== savedValueRef.current
    },
  }), [onDirtyChange, updateValue])

  const containerStyle: React.CSSProperties = {
    ...style,
    height: typeof height === 'number' ? `${height}px` : height,
    width: typeof width === 'number' ? `${width}px` : width,
  }

  // Sizes the textarea when the container has no definite height, where a CSS
  // height cannot resolve and the element would collapse to the default two rows.
  const rows = Math.max(currentValue.split('\n').length + 1, 4)

  return (
    <div
      className={`m-editor m-editor-mode-source-fallback ${className}`}
      data-openbitfun-component="m-editor"
      data-openbitfun-part="root"
      data-m-editor-fallback="true"
      style={containerStyle}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
          event.preventDefault()
          event.stopPropagation()
          onSave?.(currentValueRef.current)
        }
      }}
    >
      <div className="m-editor-notice" data-openbitfun-component="m-editor" data-openbitfun-part="notice" role="status">
        {t('editor.markdownEditor.notice.sourcePreviewFallback')}
      </div>
      <textarea
        ref={textareaRef}
        className="m-editor-source-fallback"
        value={currentValue}
        rows={rows}
        readOnly={readonly}
        autoFocus={autofocus}
        placeholder={placeholder}
        onChange={(event) => updateValue(event.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        spellCheck={false}
      />
    </div>
  )
})

MEditorSourceFallback.displayName = 'MEditorSourceFallback'

interface MEditorErrorBoundaryProps {
  children: ReactNode
  editorProps: MEditorProps
  forwardedRef: ForwardedRef<EditorInstance>
}

interface MEditorErrorBoundaryState {
  error: Error | null
}

export class MEditorErrorBoundary extends Component<
  MEditorErrorBoundaryProps,
  MEditorErrorBoundaryState
> {
  state: MEditorErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): MEditorErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    log.error('Markdown editor render failed, showing source fallback', {
      message: error.message,
      componentStack: errorInfo.componentStack,
      filePath: this.props.editorProps.filePath,
    })
  }

  // Only a new document clears the error. Retrying on every prop change would
  // re-mount the editor that just threw and loop, because the failures this
  // guards against (unsupported engine features) are deterministic.
  componentDidUpdate(previousProps: MEditorErrorBoundaryProps) {
    if (
      this.state.error &&
      previousProps.editorProps.filePath !== this.props.editorProps.filePath
    ) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <MEditorSourceFallback
          {...this.props.editorProps}
          ref={this.props.forwardedRef}
        />
      )
    }

    return this.props.children
  }
}

const MEditorInner = forwardRef<EditorInstance, MEditorProps>((props, ref) => {
  const {
    value: controlledValue,
    defaultValue = '',
    height = '500px',
    width = '100%',
    mode: initialMode = 'ir',
    toolbar = false,
    placeholder: placeholderProp,
    readonly = false,
    autofocus = false,
    onChange,
    onSave,
    onFocus,
    onBlur,
    onDirtyChange,
    className = '',
    style = {},
    filePath,
    basePath
  } = props

  const { t } = useI18n('tools')
  const placeholder = placeholderProp ?? t('editor.meditor.placeholder')
  const containerRef = useRef<HTMLDivElement>(null)
  const textareaTargetIdRef = useRef(`markdown-textarea-${++markdownTextareaTargetCounter}`)
  const initialEditorValue = controlledValue ?? defaultValue
  const savedValueRef = useRef(initialEditorValue)
  const currentValueRef = useRef(initialEditorValue)

  const {
    value,
    setValue,
    mode,
    setMode,
    textareaRef,
    editorInstance
  } = useEditor(controlledValue ?? defaultValue, onChange, initialMode)

  const tiptapEditorRef = useRef<TiptapEditorHandle>(null)
  const effectiveMode = mode

  useEffect(() => {
    currentValueRef.current = value
  }, [value])

  useEffect(() => {
    if (effectiveMode === 'ir') {
      return
    }

    const targetId = textareaTargetIdRef.current

    return activeEditTargetService.bindTarget({
      id: targetId,
      kind: 'markdown-textarea',
      focus: () => {
        textareaRef.current?.focus()
      },
      hasTextFocus: () => {
        const textarea = textareaRef.current
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null
        return !!textarea && activeElement === textarea
      },
      undo: () => executeTextareaAction(textareaRef.current, 'undo'),
      redo: () => executeTextareaAction(textareaRef.current, 'redo'),
      cut: () => executeTextareaAction(textareaRef.current, 'cut'),
      copy: () => executeTextareaAction(textareaRef.current, 'copy'),
      paste: () => executeTextareaAction(textareaRef.current, 'paste'),
      selectAll: () => executeTextareaAction(textareaRef.current, 'selectAll'),
      containsElement: (element) => {
        const root = containerRef.current
        return !!root && !!element && root.contains(element)
      }
    })
  }, [effectiveMode, textareaRef])

  useEffect(() => {
    if (controlledValue !== undefined && controlledValue !== value) {
      currentValueRef.current = controlledValue
      editorInstance.setValue(controlledValue)
      onDirtyChange?.(controlledValue !== savedValueRef.current)
    }
  }, [controlledValue, editorInstance, onDirtyChange, value])

  useEffect(() => {
    if (initialMode) {
      setMode(initialMode)
    }
  }, [initialMode, setMode])

  const handleEditorChange = useCallback((nextValue: string) => {
    currentValueRef.current = nextValue
    setValue(nextValue)
    onDirtyChange?.(nextValue !== savedValueRef.current)
  }, [onDirtyChange, setValue])

  useImperativeHandle(ref, () => ({
    ...editorInstance,
    scrollToLine: (line: number, highlight?: boolean) => {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        tiptapEditorRef.current.scrollToLine(line, highlight)
      }
    },
    undo: () => {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        return tiptapEditorRef.current.undo()
      }
      if (effectiveMode === 'edit') {
        return executeTextareaAction(textareaRef.current, 'undo')
      }
      return false
    },
    redo: () => {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        return tiptapEditorRef.current.redo()
      }
      if (effectiveMode === 'edit') {
        return executeTextareaAction(textareaRef.current, 'redo')
      }
      return false
    },
    get canUndo() {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        return tiptapEditorRef.current.canUndo
      }
      return false
    },
    get canRedo() {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        return tiptapEditorRef.current.canRedo
      }
      return false
    },
    markSaved: () => {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        tiptapEditorRef.current.markSaved()
      }
      savedValueRef.current = currentValueRef.current
      onDirtyChange?.(false)
    },
    setInitialContent: (content: string) => {
      if (effectiveMode === 'ir' && tiptapEditorRef.current) {
        tiptapEditorRef.current.setInitialContent(content)
      }
      currentValueRef.current = content
      savedValueRef.current = content
      editorInstance.setValue(content)
      onDirtyChange?.(false)
    },
    get isDirty() {
      return currentValueRef.current !== savedValueRef.current
    }
  }), [editorInstance, effectiveMode, onDirtyChange, textareaRef])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      e.stopPropagation()  // Prevent event bubbling; avoids other listeners handling it.
      onSave?.(currentValueRef.current)
    }
  }, [onSave])

  const handleFocusCapture = useCallback(() => {
    if (effectiveMode === 'ir') {
      return
    }

    activeEditTargetService.setActiveTarget(textareaTargetIdRef.current)
  }, [effectiveMode])

  const handleBlurCapture = useCallback(() => {
    if (effectiveMode === 'ir') {
      return
    }

    window.setTimeout(() => {
      const root = containerRef.current
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null
      if (root && activeElement && root.contains(activeElement)) {
        return
      }

      activeEditTargetService.clearActiveTarget(textareaTargetIdRef.current)
    }, 0)
  }, [effectiveMode])

  const containerStyle: React.CSSProperties = {
    ...style,
    height: typeof height === 'number' ? `${height}px` : height,
    width: typeof width === 'number' ? `${width}px` : width
  }

  const modeClass = `m-editor-mode-${effectiveMode}`

  return (
    <div
      ref={containerRef}
      className={`m-editor ${modeClass} ${className}`}
      data-openbitfun-component="m-editor"
      data-openbitfun-part="root"
      style={containerStyle}
      onKeyDown={handleKeyDown}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      tabIndex={-1}
    >
      {toolbar && <div data-openbitfun-component="m-editor" data-openbitfun-part="toolbar" className="m-editor-toolbar">{t('editor.meditor.toolbarPlaceholder')}</div>}
      
      <div data-openbitfun-component="m-editor" data-openbitfun-part="content" className="m-editor-content">
        {effectiveMode === 'edit' && (
          <div data-openbitfun-component="m-editor" data-openbitfun-part="editPanel" className="m-editor-edit-panel">
            <EditArea
              ref={textareaRef}
              value={value}
              onChange={handleEditorChange}
              onFocus={onFocus}
              onBlur={onBlur}
              placeholder={placeholder}
              readonly={readonly}
              autofocus={autofocus}
            />
          </div>
        )}

        {effectiveMode === 'ir' && (
          <div data-openbitfun-component="m-editor" data-openbitfun-part="irPanel" className="m-editor-ir-panel">
            <TiptapEditor
              ref={tiptapEditorRef}
              value={value}
              onChange={handleEditorChange}
              onFocus={onFocus}
              onBlur={onBlur}
              placeholder={placeholder}
              readonly={readonly}
              autofocus={autofocus}
              filePath={filePath}
              basePath={basePath}
            />
          </div>
        )}
      </div>
    </div>
  )
})

MEditorInner.displayName = 'MEditorInner'

export const MEditor = forwardRef<EditorInstance, MEditorProps>((props, ref) => (
  <MEditorErrorBoundary editorProps={props} forwardedRef={ref}>
    <MEditorInner {...props} ref={ref} />
  </MEditorErrorBoundary>
))

MEditor.displayName = 'MEditor'
