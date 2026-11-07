import { useEffect, useRef, useState } from 'react';
import { IDLE_WAVE_MODES, MARK, idleWaveLines, toPolyline, VIEW_BOX, workingCoreStrokeWidth, workingHoverLines, type LivingState, type Point } from './geometry';
import { approachFlowOpacity, sliceFlowHighlight } from './flow';
import { DEFAULT_SETTINGS, validateSettings, type LivingLineSettings } from './settings';
import { readLivingLineSettings, saveLivingLineSettings, subscribeLivingLineSettings } from './livingLineSettingsStore';
import { LivingLineEngine } from './engine';
import './preview.scss';

type RangeKey = Exclude<keyof LivingLineSettings, 'lineColor' | 'questionColor' | 'errorColor' | 'flowColor'>;
const RANGE_CONTROLS: readonly { key: RangeKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'lineWidth', label: 'Main line width', min: 1, max: 8, step: 0.1 },
  { key: 'flowLength', label: 'Flow length', min: 6, max: 64, step: 1 },
  { key: 'flowWidth', label: 'Flow core width', min: 0.8, max: 6, step: 0.1 },
  { key: 'flowBlur', label: 'Flow blur', min: 0, max: 16, step: 0.5 },
  { key: 'flowIntensity', label: 'Flow intensity', min: 0, max: 1, step: 0.05 },
  { key: 'lineGlowBlur', label: 'Ambient glow', min: 0, max: 24, step: 1 },
  { key: 'idlePeriodSeconds', label: 'Idle flow period (seconds)', min: 2, max: 24, step: 0.5 },
  { key: 'workingPeriodSeconds', label: 'Working flow period (seconds)', min: 0.5, max: 10, step: 0.1 },
];

function rgba(hex: string, opacity: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

export function LivingLineRenderer({ state, reducedMotion, settings, hovered = false, className = '' }: { state: LivingState; reducedMotion: boolean; settings: LivingLineSettings; hovered?: boolean; className?: string }) {
  const engine = useRef<LivingLineEngine | null>(null);
  if (!engine.current) engine.current = new LivingLineEngine();
  const main = useRef<SVGPathElement>(null);
  const hoverPaths = useRef<(SVGPathElement | null)[]>([]);
  const flowPaths = useRef<(SVGPathElement | null)[]>([]);
  const ring = useRef<SVGCircleElement>(null);
  const glow = useRef<SVGCircleElement>(null);
  const options = useRef({ state, hoverEnabled: false, reducedMotion, settings });
  const [pointerOver, setPointerOver] = useState(false);
  const hoverProgress = useRef(0);
  const idleSplitProgress = useRef(0);
  const hoverTarget = useRef(false);
  const waveMode = useRef(0);
  const waveFrom = useRef(0);
  const waveTransitionStart = useRef(0);
  const nextWaveChange = useRef(0);
  const flowProgress = useRef(0);
  const flowSpeed = useRef(0);
  const flowOpacity = useRef([0, 0, 0]);
  options.current = { state, hoverEnabled: hovered || pointerOver, reducedMotion, settings };
  hoverTarget.current = pointerOver && !reducedMotion;
  useEffect(() => { engine.current!.setState(state); }, [state]);
  useEffect(() => { engine.current!.setReducedMotion(reducedMotion); }, [reducedMotion]);
  useEffect(() => {
    let frame = 0;
    let previous = 0;
    let phase = 0;
    let visible = !document.hidden;
    const render = (now: number) => {
      if (visible) {
        if (previous) {
          const delta = Math.min((now - previous) / 1000, 1 / 30);
          const points = engine.current!.step(delta);
          const d = toPolyline(points);
          const config = options.current.settings;
          const currentState = options.current.state;
          const activeColor = currentState === 'question' ? config.questionColor : currentState === 'error' ? config.errorColor : config.lineColor;
          main.current?.setAttribute('stroke', activeColor);
          const isAlertState = currentState === 'question' || currentState === 'error';
          const lineGlowBlur = isAlertState ? Math.min(config.lineGlowBlur, 8) : config.lineGlowBlur;
          const lineGlowOpacity = isAlertState ? 0.7 : 0.58;
          main.current?.style.setProperty('filter', lineGlowBlur ? `drop-shadow(0 0 ${lineGlowBlur}px ${rgba(activeColor, lineGlowOpacity)})` : 'none');
          const dt = delta;
          hoverTarget.current = options.current.hoverEnabled && !options.current.reducedMotion;
          const splitTarget = currentState === 'working' && hoverTarget.current ? 1 : 0;
          hoverProgress.current += (splitTarget - hoverProgress.current) * (1 - Math.exp(-dt / 0.24));
          const idleSplitTarget = currentState === 'idle' && hoverTarget.current ? 1 : 0;
          idleSplitProgress.current += (idleSplitTarget - idleSplitProgress.current) * (1 - Math.exp(-dt / 0.28));
          if (!options.current.reducedMotion && currentState === 'idle' && now >= nextWaveChange.current) {
            waveFrom.current = waveMode.current;
            waveMode.current = (waveMode.current + 1 + Math.floor(Math.random() * (IDLE_WAVE_MODES.length - 1))) % IDLE_WAVE_MODES.length;
            waveTransitionStart.current = now;
            nextWaveChange.current = now + 4200 + Math.random() * 3800;
          }
          let lanes: Point[][] = [];
          if (currentState === 'working') lanes = workingHoverLines(points, phase, hoverProgress.current);
          if (currentState === 'idle') {
            const blend = Math.min(1, Math.max(0, (now - waveTransitionStart.current) / 1000));
            const eased = blend * blend * (3 - 2 * blend);
            const from = IDLE_WAVE_MODES[waveFrom.current];
            const to = IDLE_WAVE_MODES[waveMode.current];
            const mode = {
              cycles: from.cycles + (to.cycles - from.cycles) * eased,
              amplitude: from.amplitude + (to.amplitude - from.amplitude) * eased,
              secondCycles: from.secondCycles + (to.secondCycles - from.secondCycles) * eased,
              secondAmplitude: from.secondAmplitude + (to.secondAmplitude - from.secondAmplitude) * eased,
              secondOpacity: from.secondOpacity + (to.secondOpacity - from.secondOpacity) * eased,
            };
            lanes = idleWaveLines(points, phase, mode, idleSplitProgress.current);
            main.current?.setAttribute('d', toPolyline(lanes[0]));
            if (idleSplitProgress.current > 0.01) {
              lanes.slice(1).forEach((line, index) => {
                const node = hoverPaths.current[index];
                node?.setAttribute('d', toPolyline(line)); node?.setAttribute('visibility', 'visible');
                node?.setAttribute('stroke', activeColor); node?.style.setProperty('stroke-width', `${config.lineWidth * 0.56}px`);
                node?.setAttribute('opacity', String(idleSplitProgress.current * 0.72));
              });
              hoverPaths.current.slice(2).forEach(node => node?.setAttribute('visibility', 'hidden'));
            } else {
              const second = lanes[1];
              hoverPaths.current[0]?.setAttribute('visibility', second ? 'visible' : 'hidden');
              if (second) hoverPaths.current[0]?.setAttribute('d', toPolyline(second));
              hoverPaths.current[0]?.setAttribute('stroke', activeColor);
              hoverPaths.current[0]?.style.setProperty('stroke-width', `${config.lineWidth}px`);
              hoverPaths.current[0]?.setAttribute('opacity', String(mode.secondOpacity));
              hoverPaths.current.slice(1).forEach(node => node?.setAttribute('visibility', 'hidden'));
            }
            main.current?.setAttribute('visibility', 'visible');
          } else {
            main.current?.setAttribute('d', d);
            const coreWidth = workingCoreStrokeWidth(hoverProgress.current, config.lineWidth);
            main.current?.style.setProperty('stroke-width', `${coreWidth}px`);
            lanes.forEach((line, index) => {
              const node = hoverPaths.current[index];
              node?.setAttribute('d', toPolyline(line)); node?.setAttribute('stroke', activeColor);
              node?.setAttribute('visibility', currentState === 'working' && hoverProgress.current > 0.001 ? 'visible' : 'hidden');
              node?.style.setProperty('stroke-width', index === 1 ? `${coreWidth}px` : `${config.lineWidth * 0.56}px`);
              node?.setAttribute('opacity', String(index === 1 ? 1 : 0.5 * hoverProgress.current));
            });
            hoverPaths.current.forEach((node, index) => { if (index >= lanes.length) node?.setAttribute('visibility', 'hidden'); });
          }
          main.current?.setAttribute('visibility', currentState === 'working' && hoverProgress.current > 0.001 ? 'hidden' : 'visible');
          main.current?.style.setProperty('stroke-width', `${currentState === 'working' ? workingCoreStrokeWidth(hoverProgress.current, config.lineWidth) : config.lineWidth}px`);
          const radius = engine.current!.getMarkRadius();
          ring.current?.setAttribute('stroke', activeColor); ring.current?.style.setProperty('stroke-width', `${config.lineWidth}px`);
          ring.current?.setAttribute('r', String(radius)); ring.current?.setAttribute('visibility', radius < 0.15 ? 'hidden' : 'visible');
          glow.current?.setAttribute('fill', activeColor);
          const glowScale = currentState === 'question' || currentState === 'error' ? 1.45 : 1.8;
          const glowPeak = currentState === 'question' || currentState === 'error' ? 0.3 : 0.22;
          const glowBreathing = isAlertState ? 0.9 + Math.sin(now / 520) * 0.1 : 1;
          glow.current?.setAttribute('r', String(radius * glowScale * glowBreathing));
          glow.current?.setAttribute('opacity', String(Math.min(glowPeak, radius / MARK.errorRadius * glowPeak) * glowBreathing));

          const flowTargets = currentState === 'idle'
            ? idleSplitProgress.current > 0.01 ? lanes : lanes.slice(0, IDLE_WAVE_MODES[waveMode.current].secondOpacity > 0.001 ? 2 : 1)
            : currentState === 'working' && hoverProgress.current > 0.01 ? lanes : [points];
          const targetSpeed = 1 / (currentState === 'working' ? config.workingPeriodSeconds : currentState === 'question' || currentState === 'error' ? Math.max(config.idlePeriodSeconds * 0.7, 3) : config.idlePeriodSeconds);
          flowSpeed.current += (targetSpeed - flowSpeed.current) * (1 - Math.exp(-dt / 0.3));
          if (!options.current.reducedMotion) flowProgress.current += dt * flowSpeed.current;
          flowPaths.current.forEach((node, index) => {
            const target = flowTargets[index];
            const progress = (flowProgress.current + index * 0.14) % 1;
            const segment = target ? sliceFlowHighlight(target, progress, config.flowLength) : [];
            const targetActive = Boolean(segment.length && config.flowIntensity > 0 && !options.current.reducedMotion);
            flowOpacity.current[index] = approachFlowOpacity(flowOpacity.current[index], targetActive, dt);
            if (!node) return;
            if (segment.length) node.setAttribute('d', toPolyline(segment));
            node.setAttribute('visibility', flowOpacity.current[index] > 0.005 ? 'visible' : 'hidden');
            node.setAttribute('stroke', config.flowColor); node.style.setProperty('stroke-width', `${config.flowWidth}px`);
            node.setAttribute('opacity', String(config.flowIntensity * flowOpacity.current[index]));
            node.style.setProperty('filter', config.flowBlur ? `drop-shadow(0 0 ${config.flowBlur}px ${rgba(config.flowColor, config.flowIntensity * flowOpacity.current[index])})` : 'none');
          });
          if (!options.current.reducedMotion) phase += (now - previous) / 1000 * 2.4;
        }
        previous = now;
      }
      frame = requestAnimationFrame(render);
    };
    const onVisibility = () => { visible = !document.hidden; previous = 0; };
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  const stroke = state === 'question' ? settings.questionColor : state === 'error' ? settings.errorColor : settings.lineColor;
  const initialD = toPolyline(engine.current.getPoints());
  return <svg className={`living-line-art state-${state} ${className}`.trim()} data-pointer-over={hovered || pointerOver} viewBox={VIEW_BOX} style={{ color: stroke }} role="img" aria-label={`LivingLine ${state}`} onPointerEnter={event => { if (event.pointerType === 'mouse') setPointerOver(true); }} onMouseEnter={() => setPointerOver(true)} onPointerLeave={() => setPointerOver(false)} onMouseLeave={() => setPointerOver(false)}>
    <path ref={main} className="main-path" d={initialD} stroke={stroke} />
    {Array.from({ length: 3 }, (_, index) => <path key={`hover-${index}`} ref={node => { hoverPaths.current[index] = node; }} className="hover-path" d={initialD} stroke={stroke} visibility="hidden" />)}
    {Array.from({ length: 3 }, (_, index) => <path key={`flow-${index}`} ref={node => { flowPaths.current[index] = node; }} className="flow-path" visibility="hidden" />)}
    <circle ref={glow} className="state-glow" cx={MARK.cx} cy={MARK.cy} r={engine.current.getMarkRadius() * 1.8} fill={stroke} opacity="0" />
    <circle ref={ring} className="state-ring" stroke={stroke} cx={MARK.cx} cy={MARK.cy} r={engine.current.getMarkRadius()} visibility="hidden" />
  </svg>;
}

export default function LivingLinePreview() {
  const [settings, setSettings] = useState(readLivingLineSettings);
  const [settingsStatus, setSettingsStatus] = useState('Using local settings');
  const [state, setState] = useState<LivingState>('idle');
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => subscribeLivingLineSettings(() => {
    setSettings(readLivingLineSettings());
    setSettingsStatus('Local settings synchronized');
  }), []);
  const update = (key: keyof LivingLineSettings, value: string | number) => {
    try {
      const next = validateSettings({ ...settings, [key]: value });
      setSettings(saveLivingLineSettings(next));
      setSettingsStatus('Saved');
    } catch (error) { setSettingsStatus(error instanceof Error ? error.message : 'Invalid settings'); }
  };
  const reset = () => {
    try {
      setSettings(saveLivingLineSettings({ ...DEFAULT_SETTINGS }));
      setSettingsStatus('Defaults restored');
    } catch { setSettingsStatus('Save failed: local storage is unavailable'); }
  };
  return <main className="living-line-preview" data-openbitfun-component="living-line-preview" data-openbitfun-part="root"><header><span className="living-line-mark">LL</span><div><p>INDEPENDENT MOTION STUDY</p><h1>LivingLine</h1></div></header>
    <section className="living-line-stage" data-openbitfun-component="living-line-preview" data-openbitfun-part="stage"><LivingLineRenderer state={state} reducedMotion={reducedMotion} settings={settings} /><span className="living-line-caption">{state.toUpperCase()} / VECTOR STATE</span></section>
    <nav className="living-line-controls" data-openbitfun-component="living-line-preview" data-openbitfun-part="controls" aria-label="LivingLine preview controls">{(['idle', 'working', 'question', 'error'] as const).map(item => <button key={item} aria-pressed={state === item} onClick={() => setState(item)}>{item}</button>)}</nav>
    <section className="living-line-options" data-openbitfun-component="living-line-preview" data-openbitfun-part="options"><span>Move the pointer over the canvas to preview the split animation</span><label><input type="checkbox" checked={reducedMotion} onChange={e => setReducedMotion(e.target.checked)} /> Reduced motion</label></section>
    <details className="living-line-settings" data-openbitfun-component="living-line-preview" data-openbitfun-part="settings"><summary>Flow and line preview settings</summary>
      <div className="settings-colors">{([['lineColor', 'Idle/Working line color'], ['questionColor', 'Question color'], ['errorColor', 'Error color'], ['flowColor', 'Flow color']] as const).map(([key, label]) => <label key={key}>{label}<input type="color" value={settings[key]} onChange={event => update(key, event.target.value)} /></label>)}</div>
      <div className="settings-ranges">{RANGE_CONTROLS.map(item => <label key={item.key}><span>{item.label}<output>{settings[item.key]}</output></span><input type="range" min={item.min} max={item.max} step={item.step} value={settings[item.key]} onChange={event => update(item.key, Number(event.target.value))} /></label>)}</div>
      <div className="settings-footer"><span role="status">{settingsStatus}</span><button onClick={reset}>Restore defaults</button></div>
    </details>
    <footer>LivingLine · Original SVG state and damping engine</footer></main>;
}
