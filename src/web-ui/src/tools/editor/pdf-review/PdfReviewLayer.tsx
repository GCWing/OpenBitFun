import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { PageViewport } from 'pdfjs-dist';
import { selectionQuads } from './pdfReviewGeometry';
import { PDF_REVIEW_INK, pdfBounds, type PdfReviewAnnotation, type PdfReviewColor, type PdfReviewTool } from './pdfReview';

export interface PdfReviewInteraction {
  annotations: PdfReviewAnnotation[];
  tool: PdfReviewTool;
  color: PdfReviewColor;
  enabled: boolean;
  selectedId?: string;
  noteLabel: string;
  onAdd: (annotation: PdfReviewAnnotation) => void;
  onSelect: (id: string) => void;
}
export function PdfReviewLayer({ viewport, pageNumber, review }: {
  viewport: PageViewport; pageNumber: number; review: PdfReviewInteraction;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<number[]>([]);
  const [strokeRevision, setStrokeRevision] = useState(0);
  const annotations = review.annotations.filter(annotation => annotation.page === pageNumber);
  const current = useRef(review);
  current.current = review;
  const makeAnnotation = (kind: PdfReviewAnnotation['kind'], rect: PdfReviewAnnotation['rect']): PdfReviewAnnotation => ({
    id: crypto.randomUUID(), kind, rect, color: current.current.color, page: pageNumber,
    createdAt: new Date().toISOString(), comments: [],
  });

  useEffect(() => {
    if (!review.enabled || review.tool !== 'highlight') return;
    let frame = 0;
    const onPointerUp = (event: globalThis.PointerEvent) => {
      const root = rootRef.current;
      const viewer = root?.closest('[data-openbitfun-component="pdf-viewer"][data-openbitfun-part="root"]');
      if (!root || !viewer || !(event.target instanceof Node) || !viewer.contains(event.target)) return;
      frame = requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || !selection.toString().trim()) return;
        const range = selection.getRangeAt(0);
        const host = root.parentElement;
        if (!host || !range.intersectsNode(host)) return;
        const quads = selectionQuads(Array.from(range.getClientRects()), host.getBoundingClientRect(), viewport);
        if (!quads.length) return;
        current.current.onAdd({ ...makeAnnotation('highlight', pdfBounds(quads)), quads, quote: selection.toString() });
      });
    };
    document.addEventListener('pointerup', onPointerUp);
    return () => { document.removeEventListener('pointerup', onPointerUp); cancelAnimationFrame(frame); };
  }, [review.enabled, review.tool, pageNumber, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * scale);
    canvas.height = Math.ceil(viewport.height * scale);
    context.scale(scale, scale);
    const renderStroke = (points: number[], color: PdfReviewColor) => {
      const rgb = PDF_REVIEW_INK[color].map(value => Math.round(value * 255));
      context.strokeStyle = `rgb(${rgb.join(' ')})`;
      context.lineWidth = 2 * viewport.scale;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      for (let index = 0; index < points.length; index += 2) {
        const [x, y] = viewport.convertToViewportPoint(points[index]!, points[index + 1]!);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    };
    for (const annotation of annotations) {
      const rgb = PDF_REVIEW_INK[annotation.color].map(value => Math.round(value * 255));
      if (annotation.kind === 'highlight') {
        context.fillStyle = `rgb(${rgb.join(' ')} / 0.35)`;
        const quads = annotation.quads ?? [];
        for (let index = 0; index < quads.length; index += 8) {
          context.beginPath();
          for (const offset of [0, 2, 6, 4]) {
            const [x, y] = viewport.convertToViewportPoint(quads[index + offset]!, quads[index + offset + 1]!);
            if (offset === 0) context.moveTo(x, y); else context.lineTo(x, y);
          }
          context.closePath();
          context.fill();
        }
      } else if (annotation.kind === 'ink') {
        for (const points of annotation.strokes ?? []) renderStroke(points, annotation.color);
      }
    }
    if (stroke.current.length) renderStroke(stroke.current, review.color);
  }, [annotations, review.color, strokeRevision, viewport]);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return viewport.convertToPdfPoint(
      Math.min(viewport.width, Math.max(0, event.clientX - bounds.left)),
      Math.min(viewport.height, Math.max(0, event.clientY - bounds.top)),
    );
  };
  return <div ref={rootRef} className="pdf-review-layer" data-tool={review.enabled ? review.tool : 'select'}
    style={{ width: viewport.width, height: viewport.height }}
    onPointerDown={event => {
      if (!review.enabled || (review.tool !== 'note' && review.tool !== 'ink') || event.button !== 0) return;
      event.preventDefault();
      if (review.tool === 'note') {
        const [x, y] = point(event);
        review.onAdd(makeAnnotation('note', [x, y - 20, x + 20, y]));
      } else {
        event.currentTarget.setPointerCapture(event.pointerId);
        stroke.current = point(event);
        setStrokeRevision(value => value + 1);
      }
    }}
    onPointerMove={event => {
      if (!stroke.current.length || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      stroke.current.push(...point(event));
      setStrokeRevision(value => value + 1);
    }}
    onPointerUp={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const points = [...stroke.current, ...point(event)];
      stroke.current = [];
      setStrokeRevision(value => value + 1);
      if (points.length >= 4) review.onAdd({ ...makeAnnotation('ink', pdfBounds(points)), strokes: [points] });
    }}
    onPointerCancel={() => { stroke.current = []; setStrokeRevision(value => value + 1); }}>
    <canvas ref={canvasRef} className="pdf-review-layer__canvas" style={{ width: viewport.width, height: viewport.height }} />
    {annotations.map(annotation => {
      const [x, y] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[3]);
      return <button key={annotation.id} type="button" className="pdf-review-layer__marker"
        data-selected={review.selectedId === annotation.id} data-resolved={annotation.resolved || undefined}
        style={{ left: Math.min(viewport.width - 24, Math.max(0, x)), top: Math.min(viewport.height - 24, Math.max(0, y)) }}
        aria-label={annotation.comments[0]?.body || annotation.quote || review.noteLabel}
        onPointerDown={event => event.stopPropagation()} onClick={() => review.onSelect(annotation.id)}>
        <MessageSquareText size={14} />
      </button>;
    })}
  </div>;
}
