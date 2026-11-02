import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Input, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { computerUseControlAPI, type ComputerUseControlSnapshot, type ComputerUseSharedFrame, type PreviewInput, type PreviewPoint } from '@/infrastructure/api/service-api/ComputerUseControlAPI';
import { pointerInPreview, previewToImage } from './previewGeometry';
import { PreviewCursor } from './PreviewCursor';

interface Gesture { pointerId: number; from: PreviewPoint; x: number; y: number; button: number; started: number; modifiers: string[]; authorization: number }
export function SharedPreview({ snapshot, onSnapshot }: { snapshot: ComputerUseControlSnapshot; onSnapshot: (next: ComputerUseControlSnapshot) => void }) {
  const { t } = useI18n('common');
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [frame, setFrame] = useState<ComputerUseSharedFrame>();
  const [tree, setTree] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [key, setKey] = useState('return');
  const [clickCount, setClickCount] = useState(1);
  const [localPointer, setLocalPointer] = useState<{ x: number; y: number }>();
  const [click, setClick] = useState<{ x: number; y: number }>();
  const seenClick = useRef<number>();
  const scrollInput = useRef<(event: WheelEvent) => void>();
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(snapshot); current.current = snapshot;
  const gesture = useRef<Gesture>(); const pending = useRef(false); const alive = useRef(true);
  const callback = useRef(onSnapshot); callback.current = onSnapshot;
  const hasFrame = frame !== undefined;
  const allowed = snapshot.sharing?.control_enabled === true && snapshot.state === 'active' && hasFrame;
  useEffect(() => {
    alive.current = true; let timer: ReturnType<typeof setTimeout>;
    const observe = async () => {
      try {
        if (!gesture.current && !pending.current) {
          const before = current.current, revision = before.sharing?.authorization_revision;
          const result = await computerUseControlAPI.observeShare(before);
          if (!alive.current || !surface.isCurrent() || gesture.current || pending.current
            || current.current.sharing?.authorization_revision !== revision) return;
          if (result.control.generation !== before.generation || result.control.target_revision !== before.target_revision) return;
          const image = result.frame;
          if (image && (!/^image\/(jpeg|png|webp)$/.test(image.mime_type) || image.width <= 0 || image.height <= 0)) throw new Error('Invalid shared frame');
          setFrame(image ?? undefined); setTree(result.tree); setError(undefined);
        }
      } catch (error) {
        if (alive.current && surface.isCurrent() && !String(error).includes('[CONTROL_BUSY]')) {
          setError(String(error)); setFrame(undefined); gesture.current = undefined;
        }
      } finally { if (alive.current && surface.isCurrent()) timer = setTimeout(() => void observe(), 1000); }
    };
    void observe();
    return () => { alive.current = false; clearTimeout(timer); gesture.current = undefined; };
  }, [surface]);
  useEffect(() => {
    gesture.current = undefined; setLocalPointer(undefined);
  }, [snapshot.sharing?.authorization_revision]);
  useEffect(() => {
    const element = container.current; if (!element) return;
    const observer = new ResizeObserver(() => { gesture.current = undefined; setLocalPointer(undefined); });
    const wheel = (event: WheelEvent) => scrollInput.current?.(event);
    element.addEventListener('wheel', wheel, { passive: false });
    observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [hasFrame]);
  const lastClick = snapshot.pointer?.last_click;
  useEffect(() => {
    setClick(undefined);
    if (!lastClick || !frame || lastClick.sequence === seenClick.current) return;
    seenClick.current = lastClick.sequence;
    setClick(pointerInPreview(frame, lastClick.x, lastClick.y) ?? undefined);
    const timer = setTimeout(() => setClick(undefined), 550);
    return () => clearTimeout(timer);
    // A new frame of the same click must not replay its feedback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastClick?.sequence, hasFrame]);
  const send = async (input: PreviewInput) => {
    if (!allowed || pending.current || !surface.isCurrent()) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const next = await computerUseControlAPI.inputShare(current.current, input);
      if (alive.current && surface.isCurrent()) callback.current(next);
    } catch (error) {
      if (alive.current && surface.isCurrent()) { setError(String(error)); setFrame(undefined); }
    } finally { pending.current = false; if (alive.current && surface.isCurrent()) setBusy(false); }
  };
  const at = (x: number, y: number) => frame && container.current
    ? previewToImage(frame, container.current.getBoundingClientRect(), x, y) : null;
  const feedback = localPointer ?? (frame && snapshot.pointer ? pointerInPreview(frame, snapshot.pointer.x, snapshot.pointer.y) : null);
  const button = (value: number) => value === 2 ? 'right' : value === 1 ? 'middle' : 'left';
  scrollInput.current = event => {
    if (!allowed || pending.current || gesture.current) return;
    const focus = at(event.clientX, event.clientY); if (!focus) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.current?.clientHeight ?? 1 : 1;
    const dx = Math.round(Math.max(-1000, Math.min(1000, event.deltaX * scale)));
    const dy = Math.round(Math.max(-1000, Math.min(1000, event.deltaY * scale)));
    if (dx || dy) void send({ action: 'app_scroll', focus, dx, dy });
  };
  return <div className="computer-control-card__sharing" data-openbitfun-component="computer-control" data-openbitfun-part="sharing">
    {frame && <div ref={container} className="computer-control-card__preview" data-openbitfun-component="computer-control" data-openbitfun-part="preview"
      onContextMenu={event => { if (allowed) event.preventDefault(); }}
      onPointerDown={event => {
        if (!allowed || pending.current || gesture.current || event.button > 2) return;
        const from = at(event.clientX, event.clientY); if (!from) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { pointerId: event.pointerId, from, x: event.clientX, y: event.clientY, button: event.button, started: performance.now(),
          authorization: snapshot.sharing?.authorization_revision ?? 0,
          modifiers: [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'alt', event.metaKey && 'meta'].filter(Boolean) as string[] };
      }}
      onPointerMove={event => {
        if (gesture.current && gesture.current.pointerId !== event.pointerId) return;
        const p = at(event.clientX, event.clientY); if (p && allowed) setLocalPointer({ x: p.x / frame.width, y: p.y / frame.height });
      }}
      onPointerLeave={() => { if (!gesture.current) setLocalPointer(undefined); }}
      onPointerCancel={event => {
        if (gesture.current?.pointerId === event.pointerId) { gesture.current = undefined; setLocalPointer(undefined); }
      }}
      onLostPointerCapture={event => {
        if (gesture.current?.pointerId === event.pointerId) { gesture.current = undefined; setLocalPointer(undefined); }
      }}
      onPointerUp={event => {
        const start = gesture.current;
        if (!start || start.pointerId !== event.pointerId) return;
        gesture.current = undefined;
        if (!allowed || start.authorization !== snapshot.sharing?.authorization_revision || start.from.screenshot_id !== frame.screenshot_id) return;
        const to = at(event.clientX, event.clientY); if (!to) return;
        event.preventDefault();
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4) {
          if (start.modifiers.length) { setError(t('computerSharing.modifiedDragUnavailable')); return; }
          void send({ action: 'app_drag', from: start.from, to, mouse_button: button(start.button), duration_ms: Math.max(1, Math.round(performance.now() - start.started)) });
        } else {
          void send({ action: 'app_click', target: to, click_count: clickCount, mouse_button: button(start.button), modifier_keys: start.modifiers });
        }
      }}>
      <img src={`data:${frame.mime_type};base64,${frame.image_base64}`} alt={t('computerControl.previewAlt')} draggable={false} />
      {feedback && <PreviewCursor x={feedback.x} y={feedback.y} immediate={!!localPointer} />}
      {click && <span key={lastClick?.sequence} className="computer-control-card__click computer-control-card__click--shared"
        data-openbitfun-component="computer-control" data-openbitfun-part="click" aria-hidden="true"
        style={{ left: `${click.x * 100}%`, top: `${click.y * 100}%` }} />}
    </div>}
    {tree && <pre className="computer-control-card__tree">{tree}</pre>}
    {allowed && <>
      <p>{t('computerSharing.previewHelp')}</p>
      <Select size="sm" aria-label={t('computerSharing.clickMode')} value={clickCount} disabled={busy}
        onValueChange={value => setClickCount(Number(value))} options={[
          { value: 1, label: t('computerSharing.singleClick') }, { value: 2, label: t('computerSharing.doubleClick') },
        ]} />
      <div className="computer-control-card__row">
        <Input size="sm" aria-label={t('computerSharing.text')} value={text} onChange={event => setText(event.target.value)} disabled={busy} />
        <Button size="sm" variant="outline" disabled={busy || !text} onClick={() => void send({ action: 'app_type_text', text })}>{t('computerSharing.sendText')}</Button>
      </div>
      <div className="computer-control-card__row">
        <Select size="sm" aria-label={t('computerSharing.key')} value={key} onValueChange={value => setKey(String(value))} disabled={busy}
          options={['return', 'tab', 'escape', 'backspace', 'up', 'down', 'left', 'right', 'control+a', 'command+a'].map(value => ({ value, label: value }))} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ action: 'app_key_chord', keys: key.split('+') })}>{t('computerSharing.sendKey')}</Button>
      </div>
    </>}
    {!frame && !tree && !error && <p role="status">{t('computerControl.previewUnavailable')}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
