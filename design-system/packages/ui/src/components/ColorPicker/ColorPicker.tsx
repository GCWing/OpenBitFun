import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { classNames } from '../../internal/classNames';
import { isImeOwnedKeyboardEvent } from '../../internal/ime';
import { Icon } from '../Icon';
import { Input } from '../Input';
import { colorPetals, hexToHsl, hslToHex, isColorHex, lightnessFromPoint, lightnessPoint, type HslColor } from './color';
import styles from './ColorPicker.module.css';

export interface ColorPickerLabels {
  color: string;
  palette: string;
  edit: string;
  apply: string;
  lightness: string;
}

export interface ColorPickerProps {
  id?: string;
  className?: string;
  /** Controlled HEX draft. Incomplete text is emitted too; validate before persisting. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  labels?: Partial<ColorPickerLabels>;
}

const defaultLabels: ColorPickerLabels = {
  color: 'Color HEX', palette: 'Choose a color', edit: 'Edit color', apply: 'Apply color', lightness: 'Lightness',
};

/** Inline flower palette: a swatch, editable HEX pill, and a curved lightness control. */
export function ColorPicker({ id, className, value: controlledValue, defaultValue, onValueChange, disabled = false, open, defaultOpen = false, onOpenChange, labels: suppliedLabels }: ColorPickerProps) {
  const labels = { ...defaultLabels, ...suppliedLabels };
  const paletteId = useId();
  const rampId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ id: number; bounds: DOMRect }>();
  const compositionRef = useRef(false);
  const skipBlurCommit = useRef(false);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(() => defaultValue ?? hslToHex({ hue: 45, saturation: 90, lightness: 60 }));
  const value = controlledValue ?? localValue;
  const emitValue = (next: string) => { setLocalValue(next); onValueChange?.(next); };
  const expanded = (open ?? uncontrolledOpen) && !disabled;
  useEffect(() => { if (!expanded) dragRef.current = undefined; }, [expanded]);
  const valid = isColorHex(value);
  const model = useRef({ hex: '', hsl: { hue: 45, saturation: 90, lightness: 60 } });
  if (valid && value.toUpperCase() !== model.current.hex) {
    model.current = { hex: value.toUpperCase(), hsl: hexToHsl(value) };
  }
  const { hsl } = model.current;
  const hex = model.current.hex || hslToHex(hsl);
  const changeOpen = (next: boolean) => {
    if (disabled) return;
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const choose = (next: HslColor) => {
    if (disabled) return;
    const nextHex = hslToHex(next);
    // Retain hue/saturation at the black and white ends of a continuous drag.
    model.current = { hex: nextHex, hsl: next };
    emitValue(nextHex);
  };
  const commit = () => {
    let next = value.trim().replace(/^#/, '');
    if (/^[\da-f]{3}$/i.test(next)) next = [...next].map(character => character + character).join('');
    if (/^[\da-f]{6}$/i.test(next)) {
      const nextHex = `#${next.toUpperCase()}`;
      if (nextHex !== value) emitValue(nextHex);
      setEditing(false);
      return true;
    }
    return false;
  };
  const finishEdit = () => {
    if (!commit()) return;
    if (inputRef.current?.ownerDocument.activeElement === inputRef.current) {
      skipBlurCommit.current = true;
      inputRef.current?.blur();
    }
  };
  const setLightness = (lightness: number) => choose({ ...hsl, lightness: Math.max(0, Math.min(100, lightness)) });
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId || disabled) return;
    const { bounds } = drag;
    if (bounds.width <= 0 || bounds.height <= 0) return;
    setLightness(lightnessFromPoint((event.clientX - bounds.left) / bounds.width * 336, (event.clientY - bounds.top) / bounds.height * 280));
  };
  const sliderKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const delta = event.shiftKey ? 10 : 1;
    const keys: Record<string, number> = {
      ArrowUp: hsl.lightness + delta, ArrowRight: hsl.lightness + delta,
      ArrowDown: hsl.lightness - delta, ArrowLeft: hsl.lightness - delta,
      PageUp: hsl.lightness + 10, PageDown: hsl.lightness - 10, Home: 0, End: 100,
    };
    const next = keys[event.key];
    if (typeof next === 'number') { event.preventDefault(); setLightness(next); }
  };
  const thumb = lightnessPoint(hsl.lightness);
  const arcTop = lightnessPoint(100), arcBottom = lightnessPoint(0);
  const arc = `M ${arcTop.x} ${arcTop.y} A 166 166 0 0 1 ${arcBottom.x} ${arcBottom.y}`;

  return <div id={id} className={classNames(styles.root, className)} data-openbitfun-component="color-picker" data-openbitfun-part="root"
    data-open={expanded} data-disabled={disabled} style={{ '--_color-picker-value': hex } as CSSProperties}
    onKeyDown={event => {
      if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event, compositionRef.current)) return;
      if (editing) {
        event.preventDefault(); event.stopPropagation(); skipBlurCommit.current = true;
        if (value !== hex) emitValue(hex);
        setEditing(false); inputRef.current?.blur();
      }
      else if (expanded) { event.stopPropagation(); changeOpen(false); swatchRef.current?.focus(); }
    }}>
    <div className={styles.control} data-openbitfun-part="control">
      <button ref={swatchRef} type="button" className={styles.swatch} data-openbitfun-part="swatch" aria-label={labels.palette}
        aria-expanded={expanded} aria-controls={paletteId} disabled={disabled} onClick={() => changeOpen(!expanded)} />
      <Input className={styles.hex} shape="pill" size="lg" aria-label={labels.color} value={value} ref={inputRef}
        placeholder="#RRGGBB" maxLength={7} invalid={!valid} disabled={disabled} spellCheck={false} autoComplete="off"
        onFocus={() => setEditing(true)} onBlur={() => {
          if (!skipBlurCommit.current) commit();
          skipBlurCommit.current = false;
          setEditing(false);
        }}
        onCompositionStart={() => { compositionRef.current = true; }} onCompositionEnd={() => { compositionRef.current = false; }}
        onChange={event => emitValue(event.target.value.toUpperCase())}
        onKeyDown={event => {
          if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event, compositionRef.current)) {
            event.preventDefault(); event.stopPropagation(); finishEdit();
          }
        }}
        trailing={<button className={styles.edit} type="button" data-openbitfun-part="edit" disabled={disabled}
          aria-label={editing ? labels.apply : labels.edit}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            if (editing) finishEdit();
            else { inputRef.current?.focus(); inputRef.current?.select(); }
          }}><Icon name={editing ? 'check-line' : 'edit'} size="sm" /></button>} />
    </div>
    <div id={paletteId} className={styles.expansion} hidden={!expanded} data-openbitfun-part="expansion">
      <div className={styles.palette} role="group" aria-label={labels.palette} data-openbitfun-part="palette">
        <div className={styles.wheel} data-openbitfun-part="wheel">
          {colorPetals.map((petal, index) => {
            const inner = index >= 12;
            const angle = (-90 + (inner ? index - 12 : index) * (inner ? 60 : 30)) * Math.PI / 180;
            const radius = index === 18 ? 0 : inner ? 16 : 28;
            const petalHex = hslToHex(petal);
            return <button key={index} type="button" className={styles.petal} data-openbitfun-part="petal"
              style={{ left: `${50 + radius * Math.cos(angle)}%`, top: `${50 + radius * Math.sin(angle)}%`, backgroundColor: petalHex, '--_color-picker-petal-index': index } as CSSProperties}
              disabled={disabled} aria-label={petalHex} aria-pressed={hex === petalHex} onClick={() => choose(petal)} />;
          })}
        </div>
        <div className={styles.lightness} role="slider" tabIndex={disabled ? -1 : 0} aria-label={labels.lightness}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsl.lightness)} aria-orientation="vertical" aria-disabled={disabled}
          data-openbitfun-part="lightness" onKeyDown={sliderKey}
          onPointerDown={event => {
            if (disabled || event.button !== 0 || dragRef.current) return;
            event.preventDefault(); event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { id: event.pointerId, bounds: event.currentTarget.getBoundingClientRect() };
            move(event);
          }}
          onPointerMove={move} onPointerUp={event => {
            if (dragRef.current?.id !== event.pointerId) return;
            move(event); dragRef.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={event => { if (dragRef.current?.id === event.pointerId) dragRef.current = undefined; }}
          onLostPointerCapture={event => { if (dragRef.current?.id === event.pointerId) dragRef.current = undefined; }}>
          <svg className={styles.track} viewBox="0 0 336 280" aria-hidden="true" focusable="false">
            <defs><linearGradient id={rampId} x1="0" y1={arcTop.y} x2="0" y2={arcBottom.y} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={hslToHex({ ...hsl, lightness: 100 })} />
              <stop offset="0.5" stopColor={hslToHex({ ...hsl, lightness: 50 })} />
              <stop offset="1" stopColor={hslToHex({ ...hsl, lightness: 0 })} />
            </linearGradient></defs>
            <path d={arc} fill="none" stroke={`url(#${rampId})`} strokeWidth="18" strokeLinecap="round" />
            <path className={styles.hitTrack} d={arc} fill="none" strokeWidth="40" />
          </svg>
          <span className={styles.thumb} data-openbitfun-part="thumb" style={{ left: `${thumb.x / 336 * 100}%`, top: `${thumb.y / 280 * 100}%` }} />
        </div>
      </div>
    </div>
  </div>;
}
