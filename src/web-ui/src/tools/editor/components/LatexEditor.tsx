import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Select, SplitView, Switch } from '@openbitfun/ui';
import { compileWorkspaceLatex, supportsLatexPreview, type LatexEngine } from '@/infrastructure/api/service-api/LatexAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { useEditorDocument } from '../services/EditorDocument';
import CodeEditor, { type CodeEditorProps } from './CodeEditor';
import './LatexEditor.scss';

const PdfViewer = lazyWithRecovery(() => import('./PdfViewer'));
const ENGINES = [
  { value: 'pdflatex' as const, label: 'pdfLaTeX' },
  { value: 'xelatex' as const, label: 'XeLaTeX' },
];
const INITIAL_PREVIEW_WIDTH = 400;

export default function LatexEditor(props: CodeEditorProps) {
  const { filePath, isActiveTab = true, onContentChange, onSave } = props;
  const { t } = useI18n('tools');
  const document = useEditorDocument();
  const peer = usePeerDeviceModeOptional();
  const supported = !!document?.scope.workspaceId &&
    supportsLatexPreview(document.scope.surfaceId, peer?.currentPeerCapabilities);
  const [engine, setEngine] = useState<LatexEngine>('pdflatex');
  const [autoCompile, setAutoCompile] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(INITIAL_PREVIEW_WIDTH);
  const [compiling, setCompiling] = useState(false);
  const [pdfBase64, setPdfBase64] = useState<string>();
  const [error, setError] = useState<string>();
  const [savedRevision, setSavedRevision] = useState(0);
  const savedSource = useRef<string>();
  const revision = useRef(0);
  const lastAttempt = useRef<string>();
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const recordSavedSource = useCallback((source: string) => {
    if (savedSource.current === source) return;
    savedSource.current = source;
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
        if (document.snapshot.isDirty) {
          throw new Error(t('editor.latexEditor.saveFailed'));
        }
      }
      if (!mounted.current) return;
      lastAttempt.current = engine + ':' + revision.current;
      const result = await compileWorkspaceLatex(document.scope, filePath, engine);
      scope.assertCurrent('compile LaTeX');
      setPdfBase64(result.pdfBase64);
    } catch (failure) {
      if (!isSurfaceChangedError(failure)) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      inFlight.current = false;
      setCompiling(false);
    }
  }, [document, engine, filePath, isActiveTab, supported, t]);

  useEffect(() => {
    if (!supported || !isActiveTab || !autoCompile || compiling ||
      lastAttempt.current === engine + ':' + savedRevision) return;
    const timer = window.setTimeout(() => { void compile(false); }, 400);
    return () => window.clearTimeout(timer);
  }, [autoCompile, compile, compiling, engine, isActiveTab, savedRevision, supported]);

  const handleContentChange = useCallback((content: string, dirty: boolean) => {
    if (!dirty) recordSavedSource(content);
    onContentChange?.(content, dirty);
  }, [onContentChange, recordSavedSource]);

  const handleSave = useCallback((content: string) => {
    recordSavedSource(content);
    onSave?.(content);
  }, [onSave, recordSavedSource]);

  const sourceEditor = (
    <CodeEditor
      {...props}
      language="latex"
      showMinimap={false}
      autoSave={props.autoSave || (supported && autoCompile)}
      onSave={handleSave}
      onContentChange={handleContentChange}
    />
  );

  return (
    <SplitView
      className="latex-editor"
      primary={sourceEditor}
      rightSize={previewWidth}
      defaultRightSize={INITIAL_PREVIEW_WIDTH}
      minLeftSize={210}
      minRightSize={210}
      dividerLabel={t('editor.latexEditor.resize')}
      onRightSizeChange={setPreviewWidth}
      secondary={
        <section className="latex-editor__preview" data-openbitfun-component="latex-editor" data-openbitfun-part="preview" aria-label={t('editor.latexEditor.preview')}>
          <div className="latex-editor__toolbar" data-openbitfun-component="latex-editor" data-openbitfun-part="toolbar">
            <strong>{t('editor.latexEditor.preview')}</strong>
            <Select
              aria-label={t('editor.latexEditor.engine')}
              className="latex-editor__engine"
              size="sm"
              value={engine}
              options={ENGINES}
              onValueChange={value => {
                const option = ENGINES.find(engineOption => engineOption.value === value);
                if (option) setEngine(option.value);
              }}
              disabled={!supported || compiling}
            />
            <Button size="sm" variant="primary" disabled={!supported || compiling} onClick={() => void compile(true)}>
              {t(compiling ? 'editor.latexEditor.compiling' : 'editor.latexEditor.compile')}
            </Button>
            <label className="latex-editor__auto" title={t('editor.latexEditor.autoCompileHint')}>
              <Switch checked={autoCompile} onCheckedChange={setAutoCompile} disabled={!supported} />
              {t('editor.latexEditor.autoCompile')}
            </label>
          </div>
          {error && (
            <details className="latex-editor__diagnostics" data-openbitfun-component="latex-editor" data-openbitfun-part="diagnostics" open={!pdfBase64}>
              <summary>
                <span role="status">
                  {t(pdfBase64 ? 'editor.latexEditor.stalePreview' : 'editor.latexEditor.compileFailed')}
                </span>
              </summary>
              <pre className="latex-editor__log">{error}</pre>
            </details>
          )}
          {pdfBase64 ? (
            <div className="latex-editor__pdf">
              <Suspense fallback={<div className="latex-editor__empty" role="status">{t('editor.pdfViewer.loading')}</div>}>
                <PdfViewer filePath={filePath} pdfBase64={pdfBase64} isActiveTab={isActiveTab} />
              </Suspense>
            </div>
          ) : !error && (
            <div className="latex-editor__empty" data-openbitfun-component="latex-editor" data-openbitfun-part="empty" role="status">
              {t(!supported ? 'editor.latexEditor.unavailable'
                : compiling ? 'editor.latexEditor.compiling' : 'editor.latexEditor.empty')}
            </div>
          )}
        </section>
      }
    />
  );
}
