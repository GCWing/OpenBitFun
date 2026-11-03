import { useMemo, useState } from 'react';
import { gallerySections, type GenUIGalleryProgram } from '../../../../shared/generative-ui/gallery';
import { galleryProgramToApp, galleryToolProvider } from './galleryRuntime';
import GenUIApplication from './GenUIApplication';
import type { GenUIVerification } from './genUIVerification';
import './GenUIGallery.scss';

const allPrograms = gallerySections.flatMap(section => section.programs);

/**
 * Development-only gallery for OpenUI Lang fixtures. Every entry is rendered
 * through GenUIApplication; the gallery owns no component-tree interpretation.
 */
export default function GenUIGallery() {
  const [selectedId, setSelectedId] = useState('life-plan');
  const [showSource, setShowSource] = useState(false);
  const [report, setReport] = useState<GenUIVerification | null>(null);
  const selected = useMemo<GenUIGalleryProgram>(() => allPrograms.find(program => program.id === selectedId) ?? allPrograms[0]!, [selectedId]);
  const definition = useMemo(() => galleryProgramToApp(selected), [selected]);

  if (!import.meta.env.DEV) {
    return <main className="gen-ui-gallery gen-ui-gallery--blocked"><h1>GenUI Gallery</h1><p>This development gallery is unavailable in production builds.</p></main>;
  }

  return <main className="gen-ui-gallery" data-openbitfun-component="gen-ui-gallery">
    <aside className="gen-ui-gallery__sidebar" aria-label="GenUI examples">
      <div className="gen-ui-gallery__brand">
        <p className="gen-ui-gallery__eyebrow">OpenBitFun · OpenUI Lang</p>
        <h1>GenUI Gallery</h1>
        <p>Hand-written executable fixtures rendered by the same component runtime used by generated apps.</p>
      </div>
      <nav>
        {gallerySections.map(section => <section key={section.id} className="gen-ui-gallery__section">
          <h2>{section.title}</h2>
          <div className="gen-ui-gallery__items">
            {section.programs.map(program => <button
              type="button"
              key={`${section.id}:${program.id}`}
              className={program.id === selected.id ? 'is-selected' : ''}
              onClick={() => { setSelectedId(program.id); setShowSource(false); setReport(null); }}
            >
              <span>{program.title}</span>
              {program.requiresTools && <small>Query</small>}
            </button>)}
          </div>
        </section>)}
      </nav>
    </aside>
    <section className="gen-ui-gallery__content">
      <header className="gen-ui-gallery__header">
        <div>
          <p className="gen-ui-gallery__eyebrow">{selected.section.replace('-', ' ')}</p>
          <h2>{selected.title}</h2>
          <p>{selected.note}</p>
          {selected.prompt && <p className="gen-ui-gallery__prompt"><strong>Prompt:</strong> {selected.prompt}</p>}
        </div>
        <div className="gen-ui-gallery__actions">
          <button type="button" onClick={() => setShowSource(value => !value)}>{showSource ? 'Hide OpenUI Lang' : 'Show OpenUI Lang'}</button>
          <span className="gen-ui-gallery__identity">{definition.libraryId}@{definition.libraryRevision}</span>
        </div>
      </header>
      <div className="gen-ui-gallery__render" data-openbitfun-part="render">
        <GenUIApplication
          key={definition.id}
          definition={definition}
          persistState={false}
          asyncProvider={selected.requiresTools ? galleryToolProvider : undefined}
          onVerification={setReport}
        />
      </div>
      <div className="gen-ui-gallery__diagnostics" data-openbitfun-part="diagnostics">
        <div className="gen-ui-gallery__diagnostic-header">
          <h3>Renderer evidence</h3>
          <span data-openbitfun-state={report?.render ?? 'pending'}>{report ? `${report.render} · ${report.interaction}` : 'pending'}</span>
        </div>
        {report?.issues.length ? <ul>{report.issues.map(issue => <li key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</li>)}</ul> : <p>Render, preflight and interaction status are reported by the shared GenUI application.</p>}
      </div>
      {showSource && <details open className="gen-ui-gallery__source">
        <summary>OpenUI Lang source</summary>
        <pre><code>{selected.code}</code></pre>
      </details>}
    </section>
  </main>;
}
