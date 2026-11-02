import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Button, DialogBody, DialogDescription, DialogFooter, Icon, type IconName,
} from '@openbitfun/ui';
import { useSubagentAvatarMotion } from '@openbitfun/ui/brand';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { APPEARANCE_DOMAIN_TOKENS } from '@/infrastructure/appearance/appearanceDomainTokens';
import type { HarnessId } from '@/shared/agents/identity';
import robot01 from '@/flow_chat/assets/subagent-avatars/robot-01.svg?raw';
import robot02 from '@/flow_chat/assets/subagent-avatars/robot-02.svg?raw';
import robot03 from '@/flow_chat/assets/subagent-avatars/robot-03.svg?raw';
import robot04 from '@/flow_chat/assets/subagent-avatars/robot-04.svg?raw';
import robot06 from '@/flow_chat/assets/subagent-avatars/robot-06.svg?raw';
import './HarnessPreviewDialog.scss';

// Ported from product-film's ModeStage: the same 400px stage, hop arcs and beats.
// The preview owns no session/runtime state and plays only while its dialog is open.
const WIDTH = 400;
const STAGE_TOP = 32;
const HEIGHT = 248;
const DURATION = 2.65;
type Point = { x: number; y: number };
type Pose = Point & { lift: number; squash: number; lean: number };
const TASK = { x: 58, y: 188 };
const RESULT = { x: 342, y: 188 };
const STEPS = [{ x: 153, y: 188 }, { x: 247, y: 188 }];
const CELLS = [{ x: 168, y: 150 }, { x: 232, y: 150 }, { x: 168, y: 226 }, { x: 232, y: 226 }];
const APP = { x: 212, y: 124, w: 152, h: 104 };
const cleanArtwork = (source: string) => source
  .replace(/<title\b[^>]*>[\s\S]*?<\/title>/, '')
  .replace(/\s(?:aria-labelledby|role)="[^"]*"/g, '');
const SOLO_ART = cleanArtwork(robot04);
const CREW_ART = [robot01, robot02, robot06, robot03].map(cleanArtwork);
const CREW_COLORS = ['robot-01', 'robot-02', 'robot-06', 'robot-03']
  .map(id => APPEARANCE_DOMAIN_TOKENS.subagentAvatar(id));
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const progress = (t: number, start: number, end: number) => clamp((t - start) / (end - start));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const sine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const doneAt = (t: number, at: number) => t <= at ? 0 : progress(t, at, at + 0.35);
const rect = (x: number, y: number, w: number, h: number): CSSProperties => ({
  left: `${x / WIDTH * 100}%`, top: `${(y - STAGE_TOP) / HEIGHT * 100}%`,
  width: `${w / WIDTH * 100}%`, height: `${h / HEIGHT * 100}%`,
});

function landing(t: number, at: number) {
  const u = (t - at) / 0.36;
  return u < 0 || u > 1 ? 0 : 0.2 * (1 - u) ** 2 * Math.cos(u * Math.PI * 1.5);
}

const stand = (point: Point, squash = 0): Pose => ({ ...point, lift: 0, squash, lean: 0 });

function hop(t: number, start: number, end: number, from: Point, to: Point, height: number): Pose {
  const u = progress(t, start, end);
  if (u < 0.16) return stand(from, 0.16 * Math.sin(u / 0.16 * Math.PI / 2));
  const v = (u - 0.16) / 0.84;
  const arc = Math.sin(Math.PI * v);
  return {
    x: mix(from.x, to.x, sine(v)), y: mix(from.y, to.y, sine(v)),
    lift: arc * height, lean: Math.sign(to.x - from.x) * 7 * arc,
    squash: v < 0.5 ? -0.09 * Math.sin(Math.PI * v * 2) : -0.04 * Math.sin(Math.PI * (v - 0.5) * 2),
  };
}

/** A short, replayable illustration; reduced motion shows the completed scene. */
function usePreviewTime(active: boolean, replay: number) {
  const [time, setTime] = useState(0);
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    if (!active) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forced = window.matchMedia('(forced-colors: active)');
    let frame = 0;
    let elapsed = 0;
    let previous: number | undefined;
    const tick = (now: number) => {
      if (previous !== undefined) elapsed = Math.min(DURATION, elapsed + (now - previous) / 1000);
      previous = now;
      setTime(elapsed);
      if (elapsed < DURATION) frame = window.requestAnimationFrame(tick);
      else setMotion(false);
    };
    const sync = () => {
      window.cancelAnimationFrame(frame);
      previous = undefined;
      if (reduced.matches || forced.matches) {
        elapsed = DURATION;
        setTime(DURATION);
        setMotion(false);
      } else if (!document.hidden && elapsed < DURATION) {
        setMotion(true);
        frame = window.requestAnimationFrame(tick);
      } else setMotion(false);
    };
    setTime(0);
    sync();
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    forced.addEventListener('change', sync);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      forced.removeEventListener('change', sync);
    };
  }, [active, replay]);
  return { time, motion: active && motion };
}

function Actor({ pose, size = 52, art = SOLO_ART, status = 'idle', motion }: {
  pose: Pose; size?: number; art?: string; status?: string; motion: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useSubagentAvatarMotion(ref, status, motion, art);
  return (
    <span className="harness-preview__actor" style={rect(pose.x - size / 2, pose.y - size * 0.9375, size, size)}>
      <span className="harness-preview__actor-shadow" style={{ opacity: 1 / (1 + pose.lift / size) }} />
      <span ref={ref} className="harness-preview__actor-art" style={{
        transform: `translateY(${-pose.lift / size * 100}%) rotate(${pose.lean}deg) scale(${1 + pose.squash}, ${1 - pose.squash})`,
      }}>
        <span data-subagent-motion-art="true" dangerouslySetInnerHTML={{ __html: art }} />
      </span>
    </span>
  );
}

function Tile({ at, icon, lit = false, done = 0, t, landed, size = 40, color }: {
  at: Point; icon?: IconName; lit?: boolean; done?: number; t: number;
  landed?: number; size?: number; color?: string;
}) {
  const dip = landed === undefined ? 0 : landing(t, landed);
  const pop = 1 + 0.18 * Math.sin(Math.PI * clamp(done * 1.6)) * (1 - done);
  return (
    <span className="harness-preview__tile" data-lit={lit || undefined} data-done={done > 0 || undefined}
      style={{ ...rect(at.x - size / 2, at.y, size, size), color,
        transform: `translateY(${dip * 25}%) scale(${pop})`,
      }}>
      {icon && <Icon name={icon} size="md" />}
    </span>
  );
}

function MinimalScene({ t, motion }: { t: number; motion: boolean }) {
  const pose = t < 0.4 ? stand(TASK) : t < 1 ? hop(t, 0.4, 1, TASK, RESULT, 96) : stand(RESULT, landing(t, 1));
  return <>
    <Tile at={TASK} icon="message-square" lit t={t} />
    <Tile at={RESULT} icon={t > 1 ? 'check-line' : undefined} done={doneAt(t, 1)} t={t} />
    <Actor pose={pose} status={t >= 1.1 ? 'completed' : 'running'} motion={motion} />
  </>;
}

function StandardScene({ t, motion }: { t: number; motion: boolean }) {
  const path = [TASK, ...STEPS, RESULT];
  const step = Math.min(2, Math.floor(t / 0.5));
  const pose = t < 1.5 ? hop(t, step * 0.5, (step + 1) * 0.5, path[step], path[step + 1], 44) : stand(RESULT, landing(t, 1.5));
  return <>
    <Tile at={TASK} icon="message-square" lit t={t} />
    <Tile at={STEPS[0]} icon="edit" lit={t >= 0.5} landed={0.5} t={t} />
    <Tile at={STEPS[1]} icon="scan-eye" lit={t >= 1} landed={1} t={t} />
    <Tile at={RESULT} icon={t > 1.5 ? 'check-line' : undefined} done={doneAt(t, 1.5)} t={t} />
    <Actor pose={pose} status={t >= 1.6 ? 'completed' : 'running'} motion={motion} />
  </>;
}

function UltimateScene({ t, motion }: { t: number; motion: boolean }) {
  const burst = progress(t, 1.5, 2);
  return <>
    <Tile at={TASK} icon="message-square" lit t={t} />
    {CELLS.map((cell, index) => <Tile key={index} at={cell} size={34} color={CREW_COLORS[index]}
      lit={t >= 0.5 && t < 1.7} landed={0.5} t={t} />)}
    <Tile at={RESULT} icon={t > 1.5 ? 'check-line' : undefined} done={doneAt(t, 1.5)} t={t} />
    {t < 1.5 && CELLS.map((cell, index) => {
      const pose = t < 0.5 ? hop(t, 0, 0.5, TASK, cell, 58)
        : t < 1.125 ? stand(cell, landing(t, 0.5)) : hop(t, 1.125, 1.5, cell, RESULT, 50);
      const scale = t < 0.5 ? mix(0.35, 1, easeOut(progress(t, 0, 0.3)))
        : t < 1.125 ? 1 : mix(1, 0.4, progress(t, 1.325, 1.5) ** 3);
      return <Actor key={index} pose={pose} art={CREW_ART[index]} size={38 * scale} status="running" motion={motion} />;
    })}
    {burst > 0 && burst < 1 && Array.from({ length: 8 }, (_, index) => {
      const angle = index / 8 * Math.PI * 2 + Math.PI / 8;
      const radius = 18 + 30 * easeOut(burst);
      const size = 6 * (1 - burst);
      return <span key={index} className="harness-preview__dot" style={{
        ...rect(RESULT.x + Math.cos(angle) * radius - size / 2, RESULT.y + 20 + Math.sin(angle) * radius - size / 2, size, size),
        background: CREW_COLORS[index % CREW_COLORS.length],
      }} />;
    })}
  </>;
}

function CreativeScene({ t, motion }: { t: number; motion: boolean }) {
  const pieces = [
    { lands: 0.5, x: APP.x, y: APP.y, w: APP.w, h: APP.h, className: 'harness-preview__app',
      content: <span className="harness-preview__app-dots"><i /><i /><i /></span> },
    { lands: 1, x: APP.x + 12, y: APP.y + 26, w: APP.w - 24, h: 42, className: 'harness-preview__app-art', content: <span /> },
    { lands: 1.5, x: APP.x + 12, y: APP.y + 78, w: 58, h: 14, className: 'harness-preview__app-button', content: null },
  ];
  const throwing = pieces.find(piece => t >= piece.lands - 0.5 && t < piece.lands - 0.25);
  const pose = throwing ? hop(t, throwing.lands - 0.5, throwing.lands - 0.25, TASK, TASK, 18)
    : stand(TASK, Math.max(...pieces.map(piece => landing(t, piece.lands - 0.25))));
  return <>
    <Tile at={TASK} icon="message-square" lit t={t} />
    {pieces.map((piece, index) => {
      const flight = progress(t, piece.lands - 0.375, piece.lands);
      if (flight <= 0) return null;
      const x = mix(TASK.x + 16, piece.x + piece.w / 2, sine(flight));
      const y = mix(TASK.y - 40, piece.y + piece.h / 2, sine(flight)) - Math.sin(Math.PI * flight) * 70;
      const scale = mix(0.3, 1, easeOut(flight)) * (1 - 0.08 * Math.sin(Math.PI * progress(t, piece.lands, piece.lands + 0.25)));
      return <span key={index} className={piece.className} style={{ ...rect(x - piece.w / 2, y - piece.h / 2, piece.w, piece.h),
        transform: `rotate(${(1 - easeOut(flight)) * -14}deg) scale(${scale})`,
      }}>{piece.content}</span>;
    })}
    {t > 1.5 && <span className="harness-preview__sparkle" style={{
      ...rect(APP.x + APP.w - 13, APP.y - 13, 26, 26), transform: `scale(${easeOut(progress(t, 1.5, 1.9))})`,
    }}><Icon name="spark" size="lg" /></span>}
    <Actor pose={pose} status={t >= 1.6 ? 'completed' : 'running'} motion={motion} />
  </>;
}

const SCENES = { Minimal: MinimalScene, Standard: StandardScene, Ultimate: UltimateScene, Creative: CreativeScene };

function HarnessPreview({ profile, active, replay, onReplay, replayLabel }: {
  profile: HarnessId; active: boolean; replay: number; onReplay: () => void; replayLabel: string;
}) {
  const { time, motion } = usePreviewTime(active, replay);
  const Scene = SCENES[profile];
  return <button type="button" className="harness-preview__stage" aria-label={replayLabel} onClick={onReplay}
    data-testid="harness-preview-animation" data-profile={profile}
    data-openbitfun-scene="agents" data-openbitfun-part="harnessPreview">
    <span aria-hidden="true"><Scene t={time} motion={motion} /></span>
  </button>;
}

export function HarnessPreviewContent({ profile, transitioning, descriptionId, onManage }: {
  profile: HarnessId; transitioning: boolean; descriptionId: string; onManage: () => void;
}) {
  const { t } = useI18n('scenes/agents');
  const [replay, setReplay] = useState(0);
  return (
    <>
      <DialogBody className="harness-preview__body">
        <HarnessPreview key={profile} profile={profile} active={!transitioning}
          replay={replay} onReplay={() => setReplay(value => value + 1)} replayLabel={t('harnessZone.replay')} />
        <DialogDescription id={descriptionId} className="harness-preview__description" data-testid="harness-preview-description">
          {t(`harnessZone.profiles.${profile}.description`)}
        </DialogDescription>
      </DialogBody>
      <DialogFooter className="harness-preview__footer">
        <Button variant="primary" size="md" className="harness-preview__manage" onClick={onManage} disabled={transitioning}
          data-testid="harness-preview-manage">{t('manage')}</Button>
      </DialogFooter>
    </>
  );
}
