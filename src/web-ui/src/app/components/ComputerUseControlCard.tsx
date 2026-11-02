import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Card, CardBody, CardFooter, CardHeader, OverlayLayer, OverflowText } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import {
  computerUseControlAPI, projectControlPointer,
  type ComputerUseControlSnapshot, type ComputerUseControlPreview,
} from '@/infrastructure/api/service-api/ComputerUseControlAPI';
import './ComputerUseControlCard.scss';
import { ComputerUseSharingControls } from './ComputerUseSharingControls';
import { SharedPreview } from './computer-use/SharedPreview';
import { PreviewCursor } from './computer-use/PreviewCursor';

interface View {
  epoch: number;
  snapshot: ComputerUseControlSnapshot;
  frame?: ComputerUseControlPreview;
  framePointer?: ComputerUseControlSnapshot['pointer'];
  error?: boolean;
}

function acceptsUpdate(current: ComputerUseControlSnapshot | undefined, next: ComputerUseControlSnapshot) {
  if (!current || current.generation !== next.generation) return !current || next.generation > current.generation;
  if ((current.target_revision ?? 0) !== (next.target_revision ?? 0)) return (next.target_revision ?? 0) > (current.target_revision ?? 0);
  return (next.sharing?.authorization_revision ?? 0) >= (current.sharing?.authorization_revision ?? 0);
}

/** One card for the executing host in the shared notification region. */
export function ComputerUseControlCard() {
  const { t } = useI18n('common');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [view, setView] = useState<View>();
  const [collapsed, setCollapsed] = useState<string>();
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const mutation = useRef(0);
  const [stopping, setStopping] = useState(false);
  const [clickFeedback, setClickFeedback] = useState<{ x: number; y: number } | null>(null);
  const current = view?.epoch === scope.epoch ? view : undefined;
  const snapshot = current?.snapshot;
  const identity = `${scope.epoch}:${snapshot?.generation}`;
  const expanded = collapsed !== identity;
  const active = snapshot?.state === 'active' || snapshot?.state === 'starting' || snapshot?.state === 'awaiting_share';

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setView(undefined);
    setStopping(false);
    const poll = async () => {
      const revision = mutation.current;
      try {
        const next = await computerUseControlAPI.status();
        if (disposed || !scope.isCurrent() || revision !== mutation.current) return;
        setView(previous => ({ epoch: scope.epoch, snapshot: next,
          ...(next.state === 'active' && previous?.epoch === scope.epoch && previous.snapshot.generation === next.generation
            && previous.snapshot.target === next.target
            && (previous.snapshot.target_revision ?? 0) === (next.target_revision ?? 0) ? { frame: previous.frame, framePointer: previous.framePointer } : {}),
        }));
        // A collapse applies only to this device and control generation. New
        // control must request its first frame in the same poll as its status.
        if (collapsedRef.current !== `${scope.epoch}:${next.generation}` && next.supported && next.state === 'active' && !next.sharing) {
          try {
            const frame = await computerUseControlAPI.preview(next.generation);
            if (disposed || !scope.isCurrent() || revision !== mutation.current) return;
            if (!frame || frame.generation !== next.generation || frame.target !== next.target
              || (frame.target_revision ?? 0) !== (next.target_revision ?? 0)) {
              throw new Error('Control preview target changed');
            }
            if (!/^image\/(png|jpeg|webp)$/.test(frame.mime_type) || frame.width <= 0 || frame.height <= 0) {
              throw new Error('Invalid control preview');
            }
            setView(previous => previous?.snapshot.generation === next.generation
              && previous.snapshot.target === next.target
              && (previous.snapshot.target_revision ?? 0) === (next.target_revision ?? 0)
              ? { ...previous, frame, framePointer: next.pointer } : previous);
          } catch {
            // Preview is optional (for example, an AX-only observation). A
            // missing, stale or failed frame does not invalidate live status.
            if (!disposed && scope.isCurrent() && revision === mutation.current) setView(previous => previous && {
              ...previous, frame: undefined, framePointer: undefined,
            });
          }
        }
      } catch {
        // Older peers may not expose this capability. Retain a previously
        // active card with an explicit unavailable state, never a local fallback.
        if (!disposed && scope.isCurrent() && revision === mutation.current) setView(previous => previous && {
          ...previous, frame: undefined, framePointer: undefined, error: true,
        });
      } finally {
        if (!disposed && scope.isCurrent()) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [scope]);

  const stop = async () => {
    if (!snapshot || !scope.isCurrent()) return;
    mutation.current += 1;
    setStopping(true);
    try {
      const next = await computerUseControlAPI.stop(snapshot.generation);
      if (scope.isCurrent()) {
        mutation.current += 1;
        setView({ epoch: scope.epoch, snapshot: next });
      }
    } catch {
      if (scope.isCurrent()) setView(previous => previous && { ...previous, error: true });
    } finally {
      if (scope.isCurrent()) setStopping(false);
    }
  };

  const lastClick = current?.framePointer?.last_click;
  const clickIdentity = `${scope.epoch}:${snapshot?.generation}:${snapshot?.target}:${snapshot?.target_revision ?? 0}:${lastClick?.sequence}`;
  useEffect(() => {
    setClickFeedback(null);
    if (!expanded || !current?.frame || !lastClick) return;
    const point = projectControlPointer(current.frame, { ...lastClick, click: true });
    if (!point) return;
    setClickFeedback(point);
    const timer = setTimeout(() => setClickFeedback(null), 300);
    return () => clearTimeout(timer);
    // The retained click sequence, rather than the instantaneous down/up bit,
    // survives polling. New frames of the same click must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clickIdentity, expanded]);

  if (!snapshot?.supported || !active || !snapshot.owner) return null;
  const pointer = current?.frame ? projectControlPointer(current.frame, current.framePointer ?? null) : null;
  const mode = snapshot.mode === 'observe' ? t('computerControl.observe')
    : snapshot.mode === 'foreground' ? t('computerControl.foreground') : t('computerControl.background');

  return <OverlayLayer passive>
    <div className="computer-control-card" data-openbitfun-component="computer-control" data-openbitfun-part="root">
    <Card appearance="raised" padding="md" gap="sm" radius="md" className="computer-control-card__panel"
      data-openbitfun-native-webview-occlusion>
      <CardHeader>{t('computerControl.title')}</CardHeader>
      <CardBody className="computer-control-card__body">
        <p role="status" className="computer-control-card__status" data-openbitfun-component="computer-control" data-openbitfun-part="status">
          {current?.error ? t('computerControl.unavailable') : snapshot.state === 'awaiting_share' ? t('computerSharing.selectApp') : mode}
        </p>
        {snapshot.target && <OverflowText>{snapshot.sharing?.target_label || snapshot.target}</OverflowText>}
        {snapshot.sharing && <ComputerUseSharingControls snapshot={snapshot}
          onMutation={() => { mutation.current += 1; }}
          onSnapshot={next => {
            if (!scope.isCurrent()) return;
            mutation.current += 1;
            setView(previous => !acceptsUpdate(previous?.snapshot, next) ? previous : { epoch: scope.epoch, snapshot: next });
            if (next.sharing?.phase === 'shared') setCollapsed(undefined);
          }} />}
        {expanded && snapshot.sharing?.phase === 'shared' && <SharedPreview key={`${scope.epoch}:${snapshot.generation}:${snapshot.target_revision}`}
          snapshot={snapshot} onSnapshot={next => {
            if (!scope.isCurrent()) return;
            mutation.current += 1;
            setView(previous => !acceptsUpdate(previous?.snapshot, next) ? previous : { epoch: scope.epoch, snapshot: next });
          }} />}
        {expanded && !snapshot.sharing && current?.frame && <div className="computer-control-card__preview" data-openbitfun-component="computer-control" data-openbitfun-part="preview">
          <img src={`data:${current.frame.mime_type};base64,${current.frame.image_base64}`}
            alt={t('computerControl.previewAlt')} />
          {pointer && <PreviewCursor key={`${identity}:${snapshot.target}:${snapshot.target_revision ?? 0}`}
            x={pointer.x} y={pointer.y} />}
          {clickFeedback && <span className="computer-control-card__click"
            data-openbitfun-component="computer-control" data-openbitfun-part="click"
            style={{ left: `${clickFeedback.x * 100}%`, top: `${clickFeedback.y * 100}%` }} aria-hidden="true" />}
        </div>}
        {expanded && !snapshot.sharing && !current?.frame && <p role="status">{t('computerControl.previewUnavailable')}</p>}
      </CardBody>
      <CardFooter>
        {snapshot.state === 'active' && <Button size="sm" variant="outline" aria-expanded={expanded}
          onClick={() => setCollapsed(expanded ? identity : undefined)}>
          {expanded ? t('computerControl.hidePreview') : t('computerControl.showPreview')}
        </Button>}
        <Button size="sm" variant="primary" disabled={stopping} onClick={() => void stop()}>
          {stopping ? t('computerControl.stopping') : t('computerControl.stop')}
        </Button>
      </CardFooter>
    </Card>
    </div>
  </OverlayLayer>;
}
