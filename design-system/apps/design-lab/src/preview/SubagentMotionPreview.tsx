import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Icon, SegmentedControl } from "@openbitfun/ui";
import { SubagentHatch, type SubagentHatchPhase } from "@openbitfun/ui/brand";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { SUBAGENT_AVATAR_CATALOG, type SubagentAvatarId } from "../assets/subagentAvatars";
import { useI18n } from "../i18n";
import {
  lookMotionClip,
  pressHoldClip,
  pressReleaseClip,
  subagentMotionClips,
  subagentBasicMotionIds,
  subagentTransitionIds,
  subagentMotionSequence,
  type SubagentMotionId,
} from "./subagentMotion";
import { createSubagentMotionPlayer, type SubagentMotionPlayer } from "./subagentMotionPlayer";
import "./SubagentMotionPreview.css";

const characterSources = import.meta.glob<string>(
  "../../../../../src/web-ui/src/flow_chat/assets/subagent-avatars/robot-*.svg",
  { eager: true, query: "?raw", import: "default" },
);

const characterArtworks = new Map(SUBAGENT_AVATAR_CATALOG.map(({ id }) => {
  const source = characterSources[`../../../../../src/web-ui/src/flow_chat/assets/subagent-avatars/${id}.svg`];
  if (!source) throw new Error(`Missing Subagent motion artwork: ${id}`);
  // These are trusted local assets. Each sample gets its name from the preview.
  const artwork = source
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/, "")
    .replace(/\s(?:aria-labelledby|role)="[^"]*"/g, "");
  return [id, artwork] as const;
}));

function Character({ id, size }: { id: SubagentAvatarId; size: number }) {
  return (
    <span
      aria-hidden="true"
      className="subagent-motion-art"
      dangerouslySetInnerHTML={{ __html: characterArtworks.get(id)! }}
      key={id}
      style={{ width: size, height: size } as CSSProperties}
    />
  );
}

function HatchPreview({ avatarId }: { avatarId: SubagentAvatarId }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<SubagentHatchPhase>('incubating');
  const avatar = SUBAGENT_AVATAR_CATALOG.find(avatar => avatar.id === avatarId)!;
  return <section className="subagent-motion-sequence" aria-labelledby="subagent-hatch-title">
    <div className="subagent-motion-sequence__heading">
      <div><h3 id="subagent-hatch-title">{t('subagentMotion.hatch.title')}</h3><p>{t('subagentMotion.hatch.hint')}</p></div>
      <div className="subagent-motion-controls__buttons">
        <Button onClick={() => setPhase('incubating')} size="sm">{t('subagentMotion.hatch.begin')}</Button>
        <Button disabled={phase !== 'incubating'} onClick={() => setPhase('ready')} size="sm">{t('subagentMotion.hatch.reveal')}</Button>
        <Button disabled={phase !== 'incubating'} onClick={() => setPhase('stopped')} size="sm">{t('subagentMotion.hatch.stop')}</Button>
      </div>
    </div>
    <div className="subagent-motion-sizes">
      {[112, 28, 32, 40].map(size => <figure key={size}>
        <SubagentHatch phase={phase} size={size}>
          <img src={avatar.src} width={size} height={size} alt="" draggable={false} />
        </SubagentHatch>
        <figcaption>{size} px</figcaption>
      </figure>)}
    </div>
  </section>;
}

interface SubagentMotionPreviewProps {
  avatarId: SubagentAvatarId;
  onAvatarChange: (id: SubagentAvatarId) => void;
}

export function SubagentMotionPreview({ avatarId, onAvatarChange }: SubagentMotionPreviewProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SubagentMotionPlayer>();
  const finishRef = useRef<() => void>(() => {});
  const sequenceCursor = useRef<number | null>(null);
  const pressing = useRef(false);
  const pointerFrame = useRef(0);
  const [selected, setSelected] = useState<SubagentMotionId>("idle");
  const [playback, setPlayback] = useState<"playing" | "paused" | "finished">("playing");
  const [speed, setSpeed] = useState("1");
  const [reduced, setReduced] = useState(false);
  const [inSequence, setInSequence] = useState(false);
  const [sequenceStep, setSequenceStep] = useState(-1);
  const playbackSettings = useRef({ selected, speed });
  playbackSettings.current = { selected, speed };

  function playMotion(id: SubagentMotionId, sequence = false) {
    setSelected(id);
    setPlayback("playing");
    playerRef.current?.setPaused(false);
    playerRef.current?.play(subagentMotionClips[id], {
      repeat: !sequence && Boolean(subagentMotionClips[id].loop),
      fromCurrent: id !== "enter",
    });
  }

  function chooseMotion(id: SubagentMotionId) {
    cancelAnimationFrame(pointerFrame.current);
    pressing.current = false;
    sequenceCursor.current = null;
    setInSequence(false);
    setSequenceStep(-1);
    playMotion(id);
  }

  finishRef.current = () => {
    const cursor = sequenceCursor.current;
    if (cursor !== null) {
      const nextIndex = cursor + 1;
      const next = subagentMotionSequence[nextIndex];
      setSequenceStep(nextIndex);
      if (next) {
        sequenceCursor.current = nextIndex;
        playMotion(next, true);
        return;
      }
      sequenceCursor.current = null;
      setInSequence(false);
    }
    setPlayback("finished");
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    sequenceCursor.current = null;
    pressing.current = false;
    setInSequence(false);
    setSequenceStep(-1);
    setPlayback("playing");
    const player = createSubagentMotionPlayer(host, () => finishRef.current());
    playerRef.current = player;
    // Rebuild for the new artwork while retaining the chosen action and speed.
    const settings = playbackSettings.current;
    player.setRate(Number(settings.speed));
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    const syncVisibility = () => {
      player.setSuspended(document.hidden || !visible);
      if (document.hidden && pressing.current) {
        pressing.current = false;
        player.play(subagentMotionClips.settle);
      }
    };
    const syncPreference = () => {
      setReduced(preference.matches);
      player.setReduced(preference.matches);
      if (preference.matches) {
        sequenceCursor.current = null;
        pressing.current = false;
        setInSequence(false);
        setSequenceStep(-1);
        setPlayback("finished");
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      syncVisibility();
    });
    observer.observe(host);
    syncPreference();
    syncVisibility();
    if (!preference.matches) player.play(subagentMotionClips[settings.selected], { fromCurrent: false });
    preference.addEventListener("change", syncPreference);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      cancelAnimationFrame(pointerFrame.current);
      observer.disconnect();
      preference.removeEventListener("change", syncPreference);
      document.removeEventListener("visibilitychange", syncVisibility);
      player.dispose();
      playerRef.current = undefined;
    };
  }, [avatarId]);

  function startSequence() {
    cancelAnimationFrame(pointerFrame.current);
    pressing.current = false;
    sequenceCursor.current = 0;
    setSequenceStep(0);
    setInSequence(true);
    playMotion(subagentMotionSequence[0]!, true);
  }

  function beginPress() {
    if (selected !== "press" || inSequence || reduced || pressing.current) return;
    pressing.current = true;
    setPlayback("playing");
    playerRef.current?.setPaused(false);
    playerRef.current?.play(pressHoldClip, { notify: false });
  }

  function endPress(cancelled = false) {
    if (!pressing.current) return;
    pressing.current = false;
    playerRef.current?.play(cancelled ? subagentMotionClips.settle : pressReleaseClip);
  }

  function stopLooking() {
    cancelAnimationFrame(pointerFrame.current);
    if (selected === "look" && !inSequence && !reduced && playback !== "paused") {
      playerRef.current?.play(subagentMotionClips.settle);
    }
  }

  const status = reduced ? "static"
    : playback === "paused" ? "paused"
    : playback === "finished" ? "held"
    : subagentMotionClips[selected].loop && !inSequence ? "looping" : "playing";

  return (
    <div className="subagent-motion-preview" ref={hostRef}>
      <section aria-labelledby="subagent-motion-characters-title" className="subagent-motion-characters">
        <h3 id="subagent-motion-characters-title">{t("subagentMotion.characters")}</h3>
        <div className="subagent-motion-character-grid">
          {SUBAGENT_AVATAR_CATALOG.map((avatar) => (
            <button
              aria-controls="subagent-motion-viewer"
              aria-pressed={avatar.id === avatarId}
              className="subagent-motion-character"
              key={avatar.id}
              onClick={() => onAvatarChange(avatar.id)}
              type="button"
            >
              <img alt="" draggable={false} height={48} src={avatar.src} width={48} />
              <span>{t(`design.character.${avatar.id}`)}</span>
            </button>
          ))}
        </div>
      </section>
      <HatchPreview avatarId={avatarId} />
      <div className="subagent-motion-layout">
        <section aria-labelledby="subagent-motion-title" className="subagent-motion-viewer" id="subagent-motion-viewer">
          <header className="subagent-motion-heading">
            <div>
              <span className="page-kicker">{avatarId}</span>
              <h2 aria-live="polite" id="subagent-motion-title">{t(`design.character.${avatarId}`)}</h2>
            </div>
            <span className="subagent-motion-status" role="status">{t(`subagentMotion.status.${status}`)}</span>
          </header>

          <button
            aria-describedby="subagent-motion-interaction-hint"
            aria-label={t("subagentMotion.interact", { name: t(`design.character.${avatarId}`) })}
            className="subagent-motion-stage"
            onBlur={() => { endPress(true); stopLooking(); }}
            onClick={() => { if (selected !== "press" && selected !== "look" && !inSequence && !reduced) chooseMotion(selected); }}
            onFocus={() => {
              if (selected === "look" && !inSequence && !reduced && playback !== "paused") {
                setPlayback("playing");
                playerRef.current?.play(lookMotionClip(0, -0.7), { notify: false });
              }
            }}
            onKeyDown={(event) => {
              if (selected === "press" && (event.key === " " || event.key === "Enter")) {
                event.preventDefault();
                beginPress();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") endPress();
            }}
            onLostPointerCapture={() => endPress(true)}
            onPointerCancel={() => endPress(true)}
            onPointerDown={(event) => {
              if (event.button === 0 && selected === "press" && !inSequence && !reduced) {
                event.currentTarget.setPointerCapture(event.pointerId);
                beginPress();
              }
            }}
            onPointerLeave={stopLooking}
            onPointerMove={(event) => {
              if (selected !== "look" || inSequence || reduced || playback === "paused") return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
              const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
              cancelAnimationFrame(pointerFrame.current);
              pointerFrame.current = requestAnimationFrame(() => {
                setPlayback("playing");
                playerRef.current?.play(lookMotionClip(x, y), { notify: false });
              });
            }}
            onPointerUp={() => endPress()}
            type="button"
          >
            <Character id={avatarId} size={224} />
          </button>
          <p className="subagent-motion-hint" id="subagent-motion-interaction-hint">
            {t(selected === "look" ? "subagentMotion.lookHint" : selected === "press" ? "subagentMotion.pressHint" : "subagentMotion.stageHint")}
          </p>

          <div className="subagent-motion-sizes" aria-label={t("subagentMotion.sizes")}>
            <span>{t("subagentMotion.sizes")}</span>
            {[28, 40, 64].map((size) => (
              <figure key={size}>
                <Character id={avatarId} size={size} />
                <figcaption>{size} px</figcaption>
              </figure>
            ))}
          </div>

          <div className="subagent-motion-controls">
            <div className="subagent-motion-controls__buttons">
              <Button disabled={reduced} leadingIcon={<Icon glyph={RotateCcw} size="sm" />} onClick={() => chooseMotion(selected)} size="sm">{t("subagentMotion.replay")}</Button>
              <Button
                disabled={reduced || playback === "finished"}
                leadingIcon={<Icon glyph={playback === "paused" ? Play : Pause} size="sm" />}
                onClick={() => {
                  const paused = playback !== "paused";
                  setPlayback(paused ? "paused" : "playing");
                  playerRef.current?.setPaused(paused);
                }}
                size="sm"
              >{t(playback === "paused" ? "subagentMotion.resume" : "subagentMotion.pause")}</Button>
              <Button disabled={reduced} leadingIcon={<Icon glyph={Square} size="sm" />} onClick={() => chooseMotion("settle")} size="sm">{t("subagentMotion.reset")}</Button>
            </div>
            <SegmentedControl
              aria-label={t("subagentMotion.speed")}
              disabled={reduced}
              onValueChange={(value) => { setSpeed(value); playerRef.current?.setRate(Number(value)); }}
              options={[{ value: "0.5", label: "0.5×" }, { value: "1", label: "1×" }, { value: "1.5", label: "1.5×" }]}
              size="sm"
              tone="neutral"
              value={speed}
            />
          </div>
          {reduced && <p className="subagent-motion-hint">{t("subagentMotion.reduced")}</p>}
        </section>

        <section aria-label={t("subagentMotion.actions")} className="subagent-motion-library">
          <h3>{t("subagentMotion.actions")}</h3>
          <div className="subagent-motion-actions">
            {subagentBasicMotionIds.map((id, index) => (
              <button
                aria-pressed={selected === id}
                className="subagent-motion-action"
                disabled={reduced}
                key={id}
                onClick={() => chooseMotion(id)}
                type="button"
              >
                <span className="subagent-motion-action__number">{String(index + 1).padStart(2, "0")}</span>
                <strong>{t(`subagentMotion.${id}.label`)}</strong>
                <span>{t(`subagentMotion.${id}.hint`)}</span>
              </button>
            ))}
          </div>
          <h3>{t("subagentMotion.transitions")}</h3>
          <div className="subagent-motion-transitions">
            {subagentTransitionIds.map((id) => (
              <Button aria-pressed={selected === id} disabled={reduced} key={id} onClick={() => chooseMotion(id)} size="sm" variant={selected === id ? "fill" : "outline"}>
                {t(`subagentMotion.${id}.label`)}
              </Button>
            ))}
          </div>
          <div className="subagent-motion-caption" aria-live="polite">
            <strong>{t(`subagentMotion.${selected}.label`)}</strong>
            <p>{t(`subagentMotion.${selected}.description`)}</p>
          </div>
        </section>
      </div>

      <section aria-label={t("subagentMotion.sequence")} className="subagent-motion-sequence">
        <div className="subagent-motion-sequence__heading">
          <div><h3>{t("subagentMotion.sequence")}</h3><p>{t("subagentMotion.sequenceHint")}</p></div>
          <Button disabled={reduced} leadingIcon={<Icon glyph={Play} size="sm" />} onClick={startSequence} size="sm">{t(inSequence ? "subagentMotion.restartSequence" : "subagentMotion.playSequence")}</Button>
        </div>
        <ol>
          {subagentMotionSequence.map((id, index) => (
            <li aria-current={sequenceStep === index ? "step" : undefined} data-complete={sequenceStep > index || undefined} key={`${index}-${id}`}>
              <span>{index + 1}</span>{t(`subagentMotion.${id}.label`)}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
