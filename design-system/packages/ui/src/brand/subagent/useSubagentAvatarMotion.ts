import { useEffect, useRef, type RefObject } from 'react';
import { createSubagentMotionPlayer, type SubagentMotionPlayer } from './subagentMotionPlayer';
import { pressHoldClip, pressReleaseClip, subagentMotionClips } from './subagentMotion';

const isWorking = (status: string) => status === 'running' || status === 'finishing';

/** Animate authored avatar parts, never the measured card or its text. */
export function useSubagentAvatarMotion(ref: RefObject<HTMLElement>, status: string, enabled: boolean, identity?: string) {
  const playerRef = useRef<SubagentMotionPlayer>();
  const statusRef = useRef(status);
  const previousStatus = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const host = ref.current;
    const view = host?.ownerDocument.defaultView;
    if (!enabled || !host || !view || typeof host.animate !== 'function') return;
    previousStatus.current = statusRef.current;
    const document = host.ownerDocument;
    const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    const forced = view.matchMedia?.('(forced-colors: active)');
    let visible = typeof IntersectionObserver === 'undefined';
    let pressing = false;
    let hovering = false;
    const rest = () => {
      if (pressing) return;
      if (isWorking(statusRef.current)) {
        player.play(subagentMotionClips.working, { notify: false });
        return;
      }
      if (hovering) {
        player.play(subagentMotionClips.hoverBlink, { notify: false });
        return;
      }
      player.play(subagentMotionClips.settle, { notify: false });
    };
    const player = createSubagentMotionPlayer(host, rest, '[data-subagent-motion-art] svg');
    playerRef.current = player;
    const active = () => visible && !document.hidden && !reduced?.matches && !forced?.matches;
    const sync = () => {
      // Offscreen avatars release their animation handles instead of accumulating paused loops.
      player.setReduced(!active());
      if (active()) rest();
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      sync();
    });
    observer?.observe(host);
    document.addEventListener('visibilitychange', sync);
    reduced?.addEventListener('change', sync);
    forced?.addEventListener('change', sync);
    const trigger = host.closest<HTMLElement>('[data-agent-capsule-trigger]');
    const hover = () => {
      hovering = true;
      // Pointer and focus changes must not replace or restart a working loop.
      if (active() && !pressing && !isWorking(statusRef.current)) rest();
    };
    const press = () => { if (active()) { pressing = true; player.play(pressHoldClip, { notify: false }); } };
    const release = () => { if (pressing) { pressing = false; if (active()) player.play({ ...pressReleaseClip, duration: 300 }); } };
    const leave = () => {
      hovering = false;
      if (pressing) release();
      else if (active() && !isWorking(statusRef.current)) rest();
    };
    const click = () => {
      pressing = false;
      if (active()) player.play({ ...subagentMotionClips.nod, duration: 260 });
    };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) press(); };
    trigger?.addEventListener('pointerenter', hover);
    trigger?.addEventListener('focus', hover);
    trigger?.addEventListener('pointerdown', press);
    trigger?.addEventListener('pointerleave', leave);
    trigger?.addEventListener('pointercancel', leave);
    trigger?.addEventListener('click', click);
    trigger?.addEventListener('keydown', keyDown);
    trigger?.addEventListener('keyup', release);
    trigger?.addEventListener('blur', leave);
    view.addEventListener('pointerup', release);
    sync();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced?.removeEventListener('change', sync);
      forced?.removeEventListener('change', sync);
      trigger?.removeEventListener('pointerenter', hover);
      trigger?.removeEventListener('focus', hover);
      trigger?.removeEventListener('pointerdown', press);
      trigger?.removeEventListener('pointerleave', leave);
      trigger?.removeEventListener('pointercancel', leave);
      trigger?.removeEventListener('click', click);
      trigger?.removeEventListener('keydown', keyDown);
      trigger?.removeEventListener('keyup', release);
      trigger?.removeEventListener('blur', leave);
      view.removeEventListener('pointerup', release);
      player.dispose();
      playerRef.current = undefined;
    };
  }, [enabled, identity, ref]);

  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = status;
    if (before === status) return;
    const player = playerRef.current;
    if (!player) return;
    const working = isWorking(status);
    if (working && isWorking(before)) return;
    const clip = working ? subagentMotionClips.working
      : status === 'completed' && isWorking(before)
        ? { ...subagentMotionClips.success, duration: 520 }
        : status === 'waiting' ? subagentMotionClips.waiting
          : status === 'error' ? subagentMotionClips.blocked
            : subagentMotionClips.settle;
    player.play(clip);
  }, [status]);
}
