import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Input, Select, SplitView, Switch, Tooltip } from '@openbitfun/ui';
import { Code2, FileText, ListTree, Logs, PanelLeft, PanelRight, Play, Redo2, Save, Search, Undo2, X } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { compileWorkspaceLatex, supportsLatexPreview, type LatexEngine } from '@/infrastructure/api/service-api/LatexAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { useEditorDocument, type EditorDocument } from '../services/EditorDocument';
import { LATEX_SNIPPETS, latexOutline, latexRoot, latexRootHint, type LatexSnippetName } from '../utils/latexDocument';
import CodeEditor, { type CodeEditorProps } from './CodeEditor';
import './LatexEditor.scss';

const PdfReviewEditor = lazyWithRecovery(() => import('../pdf-review/PdfReviewEditor'));
const ENGINES = [{ value: 'pdflatex' as const, label: 'pdfLaTeX' }, { value: 'xelatex' as const, label: 'XeLaTeX' }];
const INITIAL_PREVIEW_WIDTH = 480;
interface PaperView { source: boolean; pdf: boolean; width: number; engine: LatexEngine; auto: boolean; mainFile: string; output?: string; log?: string }
const retainedViews = new WeakMap<EditorDocument, PaperView>();

export default function LatexEditor(props: CodeEditorProps) {
  const { filePath, isActiveTab = true } = props;
  const { t } = useI18n('tools');
  const document = useEditorDocument();
  const retained = document ? retainedViews.get(document) : undefined;
  const peer = usePeerDeviceModeOptional();
  const supported = !!document?.scope.workspaceId && supportsLatexPreview(document.scope.surfaceId, peer?.currentPeerCapabilities);
  const bodyRef = useRef<HTMLDivElement>(null);
  const initializedWidth = useRef(!!retained);
  const [engine, setEngine] = useState<LatexEngine>(retained?.engine ?? 'pdflatex');
  const [autoCompile, setAutoCompile] = useState(retained?.auto ?? false);
  const [sourceOpen, setSourceOpen] = useState(retained?.source ?? true);
  const [pdfOpen, setPdfOpen] = useState(retained?.pdf ?? true);
  const [previewWidth, setPreviewWidth] = useState(retained?.width ?? INITIAL_PREVIEW_WIDTH);
  const [mainFile, setMainFile] = useState(retained?.mainFile ?? '');
  const [source, setSource] = useState(document?.snapshot?.content ?? '');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [pdfBase64, setPdfBase64] = useState<string | undefined>(retained?.output);
  const [log, setLog] = useState(retained?.log ?? '');
  const [error, setError] = useState<string>();
  const [savedRevision, setSavedRevision] = useState(0);
  const savedSource = useRef<string>();
  const revision = useRef(0);
  const lastAttempt = useRef<string>();
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const pendingLineRef = useRef<number>();
  const sourceState = useRef({ content: source, dirty: document?.snapshot?.isDirty ?? false });
  const reviewDirty = useRef(false);
  const callbacks = useRef(props);
  callbacks.current = props;
  const mainPath = latexRoot(filePath, mainFile || latexRootHint(source) || '');
  const headings = useMemo(() => latexOutline(source), [source]);
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || initializedWidth.current) return;
    const measure = () => {
      if (initializedWidth.current || body.clientWidth <= 0) return;
      initializedWidth.current = true;
      setPreviewWidth(body.clientWidth / 2);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(body);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (document) retainedViews.set(document, { source: sourceOpen, pdf: pdfOpen, width: previewWidth,
      engine, auto: autoCompile, mainFile, output: pdfBase64, log });
  }, [document, sourceOpen, pdfOpen, previewWidth, engine, autoCompile, mainFile, pdfBase64, log]);

  const recordSavedSource = useCallback((content: string) => {
    if (savedSource.current === content) return;
    savedSource.current = content;
    setSavedRevision(++revision.current);
  }, []);
  const compile = useCallback(async (saveChanges: boolean) => {
    if (!supported || !document?.isCurrent() || !isActiveTab || inFlight.current) return;
    const scope = getActiveSurfaceScope();
    inFlight.current = true;
    setCompiling(true);
    setError(undefined);
    try {
      if (saveChanges && document.snapshot?.isDirty) {
        await document.save?.();
        scope.assertCurrent('save LaTeX source');
        if (document.snapshot.isDirty) throw new Error(t('editor.latexEditor.saveFailed'));
      }
      if (!mounted.current) return;
      lastAttempt.current = engine + ':' + mainPath + ':' + revision.current;
      const result = await compileWorkspaceLatex(document.scope, mainPath, engine);
      scope.assertCurrent('compile LaTeX');
      if (!mounted.current) return;
      setPdfBase64(result.pdfBase64);
      setLog(result.log || t('editor.latexEditor.compileSuccess'));
    } catch (failure) {
      if (!isSurfaceChangedError(failure) && mounted.current) {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message); setLog(message); setLogsOpen(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setCompiling(false);
    }
  }, [document, engine, mainPath, isActiveTab, supported, t]);
  useEffect(() => {
    if (!supported || !isActiveTab || !autoCompile || compiling ||
      lastAttempt.current === engine + ':' + mainPath + ':' + savedRevision) return;
    const timer = window.setTimeout(() => { void compile(false); }, 400);
    return () => window.clearTimeout(timer);
  }, [autoCompile, compile, compiling, engine, mainPath, isActiveTab, savedRevision, supported]);
  const handleContentChange = useCallback((content: string, dirty: boolean) => {
    sourceState.current = { content, dirty };
    setSource(content);
    if (!dirty) recordSavedSource(content);
    callbacks.current.onContentChange?.(content, dirty || reviewDirty.current);
  }, [recordSavedSource]);
  const handleSave = useCallback((content: string) => {
    recordSavedSource(content);
    callbacks.current.onSave?.(content);
    callbacks.current.onContentChange?.(sourceState.current.content, sourceState.current.dirty || reviewDirty.current);
  }, [recordSavedSource]);
  const handleReviewDirty = useCallback((dirty: boolean) => {
    reviewDirty.current = dirty;
    callbacks.current.onContentChange?.(sourceState.current.content, sourceState.current.dirty || dirty);
  }, []);
  const attachEditor = useCallback((editor: Monaco.editor.IStandaloneCodeEditor | null) => {
    editorRef.current = editor;
    callbacks.current.onEditorReady?.(editor);
    if (editor && pendingLineRef.current) {
      editor.setPosition({ lineNumber: pendingLineRef.current, column: 1 });
      editor.revealLineInCenter(pendingLineRef.current);
      editor.focus(); pendingLineRef.current = undefined;
    }
  }, []);
  const goToLine = (line: number) => {
    setSourceOpen(true);
    pendingLineRef.current = line;
    editorRef.current?.setPosition({ lineNumber: line, column: 1 });
    editorRef.current?.revealLineInCenter(line);
    editorRef.current?.focus();
    if (editorRef.current) pendingLineRef.current = undefined;
  };
  const action = (name: string, payload: unknown = null) => {
    editorRef.current?.focus();
    if (name === 'editor.action.insertSnippet') {
      const snippet = (payload as { snippet: string }).snippet;
      editorRef.current?.getContribution<Monaco.editor.IEditorContribution & { insert: (value: string) => void }>('snippetController2')?.insert(snippet);
    } else editorRef.current?.trigger('paper-writing-toolbar', name, payload);
  };
  const save = async () => {
    try { await document?.saveAll(); }
    catch (failure) { setError(String(failure)); setLog(String(failure)); setLogsOpen(true); }
  };

  return <section className="latex-editor" data-openbitfun-component="latex-editor" data-openbitfun-part="root">
    <div className="latex-editor__header" data-openbitfun-component="latex-editor" data-openbitfun-part="header">
      <span className="latex-editor__file"><Code2 size={15} /><strong>{fileName}</strong></span>
      <div className="latex-editor__view-controls" role="group" aria-label={t('editor.latexEditor.panes')}>
        <Button size="sm" variant={sourceOpen ? 'secondary' : 'quiet'} leadingIcon={<PanelLeft size={14} />}
          aria-pressed={sourceOpen} onClick={() => setSourceOpen(value => !value)}>{t('editor.latexEditor.source')}</Button>
        <Button size="sm" variant={pdfOpen ? 'secondary' : 'quiet'} leadingIcon={<PanelRight size={14} />}
          aria-pressed={pdfOpen} onClick={() => setPdfOpen(value => !value)}>{t('editor.latexEditor.preview')}</Button>
      </div>
    </div>
    <div className="latex-editor__toolbar" data-openbitfun-component="latex-editor" data-openbitfun-part="toolbar">
      <Button size="sm" variant="primary" leadingIcon={<Play size={14} />} disabled={!supported || compiling} onClick={() => void compile(true)}>
        {t(compiling ? 'editor.latexEditor.compiling' : 'editor.latexEditor.compile')}
      </Button>
      <Select aria-label={t('editor.latexEditor.engine')} className="latex-editor__engine" size="sm" value={engine} options={ENGINES}
        onValueChange={value => { const option = ENGINES.find(item => item.value === value); if (option) setEngine(option.value); }} disabled={!supported || compiling} />
      <label className="latex-editor__auto" title={t('editor.latexEditor.autoCompileHint')}>
        <Switch checked={autoCompile} onCheckedChange={setAutoCompile} disabled={!supported} />{t('editor.latexEditor.autoCompile')}
      </label>
      <span className="latex-editor__separator" />
      <Tooltip content={t('editor.latexEditor.undo')} placement="bottom"><IconButton size="sm" icon={<Undo2 size={14} />}
        aria-label={t('editor.latexEditor.undo')} disabled={!sourceOpen} onClick={() => action('undo')} /></Tooltip>
      <Tooltip content={t('editor.latexEditor.redo')} placement="bottom"><IconButton size="sm" icon={<Redo2 size={14} />}
        aria-label={t('editor.latexEditor.redo')} disabled={!sourceOpen} onClick={() => action('redo')} /></Tooltip>
      <Select size="sm" className="latex-editor__insert" value="" aria-label={t('editor.latexEditor.insert')} disabled={!sourceOpen}
        placeholder={t('editor.latexEditor.insert')} options={Object.keys(LATEX_SNIPPETS).map(value => ({ value, label: t(`editor.latexEditor.snippets.${value}`) }))}
        onValueChange={value => action('editor.action.insertSnippet', { snippet: LATEX_SNIPPETS[value as LatexSnippetName] })} />
      <Tooltip content={t('editor.latexEditor.find')} placement="bottom"><IconButton size="sm" icon={<Search size={14} />}
        aria-label={t('editor.latexEditor.find')} disabled={!sourceOpen} onClick={() => action('actions.find')} /></Tooltip>
      <Button size="sm" variant="quiet" leadingIcon={<Logs size={14} />} aria-pressed={logsOpen} onClick={() => setLogsOpen(value => !value)}>{t('editor.latexEditor.logs')}</Button>
      <Button size="sm" variant="quiet" leadingIcon={<Save size={14} />} onClick={() => void save()}>{t('editor.latexEditor.save')}</Button>
    </div>
    <div ref={bodyRef} className="latex-editor__body" hidden={!sourceOpen && !pdfOpen}>
      <SplitView className="latex-editor__split" mode={sourceOpen && pdfOpen ? 'split' : sourceOpen ? 'primary' : 'secondary'}
        rightSize={previewWidth} defaultRightSize={INITIAL_PREVIEW_WIDTH} minLeftSize={240} minRightSize={280}
        dividerLabel={t('editor.latexEditor.resize')} onRightSizeChange={setPreviewWidth}
        primary={<div className="latex-editor__source" data-openbitfun-component="latex-editor" data-openbitfun-part="source">
          <div className="latex-editor__source-bar">
            <Tooltip content={t('editor.latexEditor.outline')} placement="bottom"><IconButton size="sm" icon={<ListTree size={15} />}
              aria-label={t('editor.latexEditor.outline')} aria-pressed={outlineOpen} onClick={() => setOutlineOpen(value => !value)} /></Tooltip>
            <Input size="sm" aria-label={t('editor.latexEditor.mainFile')} value={mainFile} placeholder={latexRootHint(source) || fileName}
              onValueChange={setMainFile} title={t('editor.latexEditor.mainFileHint')} />
            <IconButton size="sm" aria-label={t('editor.latexEditor.closeSource')} icon={<X size={14} />} onClick={() => setSourceOpen(false)} />
          </div>
          <div className="latex-editor__source-body">
            {outlineOpen && <nav className="latex-editor__outline" aria-label={t('editor.latexEditor.outline')}
              data-openbitfun-component="latex-editor" data-openbitfun-part="outline">
              {!headings.length && <p>{t('editor.latexEditor.outlineEmpty')}</p>}
              {headings.map(heading => <button key={heading.line} onClick={() => goToLine(heading.line)} title={heading.title}
                style={{ paddingInlineStart: 10 + Math.max(0, heading.level - 2) * 10 }}>{heading.title}</button>)}
            </nav>}
            <div className="latex-editor__code"><CodeEditor {...props} language="latex" showMinimap={false}
              isActiveTab={isActiveTab && sourceOpen} autoSave={props.autoSave || (supported && autoCompile)}
              onEditorReady={attachEditor} onSave={handleSave} onContentChange={handleContentChange} /></div>
          </div>
        </div>}
        secondary={<section className="latex-editor__preview" data-openbitfun-component="latex-editor" data-openbitfun-part="preview" aria-label={t('editor.latexEditor.preview')}>
          <div className="latex-editor__preview-bar"><span><FileText size={14} />{t('editor.latexEditor.preview')}</span>
            <IconButton size="sm" aria-label={t('editor.latexEditor.closePdf')} icon={<X size={14} />} onClick={() => setPdfOpen(false)} /></div>
          {error && <div className="latex-editor__stale" role="status">{t(pdfBase64 ? 'editor.latexEditor.stalePreview' : 'editor.latexEditor.compileFailed')}</div>}
          {pdfBase64 ? <div className="latex-editor__pdf"><Suspense fallback={<div className="latex-editor__empty" role="status">{t('editor.pdfViewer.loading')}</div>}>
            <PdfReviewEditor key={mainPath} filePath={mainPath} pdfBase64={pdfBase64} isActiveTab={isActiveTab && pdfOpen}
              onDirtyStateChange={handleReviewDirty} />
          </Suspense></div> : <div className="latex-editor__empty" data-openbitfun-component="latex-editor" data-openbitfun-part="empty" role="status">
            <FileText size={32} /><p>{t(!supported ? 'editor.latexEditor.unavailable' : compiling ? 'editor.latexEditor.compiling' : 'editor.latexEditor.empty')}</p>
          </div>}
        </section>} />
    </div>
    {!sourceOpen && !pdfOpen && <div className="latex-editor__empty" role="status">
      <Code2 size={32} /><p>{t('editor.latexEditor.panesClosed')}</p>
      <Button size="sm" onClick={() => { setSourceOpen(true); setPdfOpen(true); }}>{t('editor.latexEditor.restorePanes')}</Button>
    </div>}
    {logsOpen && <section className="latex-editor__diagnostics" data-openbitfun-component="latex-editor" data-openbitfun-part="diagnostics" aria-label={t('editor.latexEditor.logs')}>
      <header><strong>{t('editor.latexEditor.logs')}</strong><IconButton size="sm" icon={<X size={14} />} aria-label={t('editor.latexEditor.closeLogs')} onClick={() => setLogsOpen(false)} /></header>
      {log ? log.split('\n').map((line, index) => {
        const match = /(?:^|\/)([^/:]+\.tex):(\d+):/.exec(line);
        return match && match[1] === fileName ? <button className="latex-editor__log-line" key={index} onClick={() => goToLine(Number(match[2]))}>{line}</button>
          : <div className="latex-editor__log-line" key={index}>{line || '\u00a0'}</div>;
      }) : <p>{t('editor.latexEditor.noLogs')}</p>}
    </section>}
  </section>;
}
