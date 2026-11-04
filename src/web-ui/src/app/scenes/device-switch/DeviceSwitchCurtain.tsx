/**
 * Covers the workbench while a device switch rebuilds it.
 *
 * A switch resets the workbench and rebuilds it for the target device; without
 * a cover that sequence briefly shows the welcome page, a lazy-load spinner or
 * the previous scene. The curtain is the scene background: it fades in on the
 * click, shows a spinner only if the switch takes a while, and fades out once
 * the action settled and the target scene had a frame to paint.
 *
 * Opening an existing session needs no curtain: its tab is held in front and
 * the session view shows its own loading skeleton, in its own layout, so the
 * loading presentation never changes size or position mid-open.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Spinner } from '@openbitfun/ui';
import { useDeviceOpenIntent } from '@/infrastructure/peer-device/deviceOpenIntent';
import { useI18n } from '@/infrastructure/i18n';
import './DeviceSwitchCurtain.scss';

type Phase = 'hidden' | 'covering' | 'leaving';
export const DEVICE_SWITCH_CURTAIN_LEAVE_MS = 220;

/** Existing-session opens are presented by the held session tab. */
const needsCurtain = (key: string) => !key.startsWith('session:');

export const DeviceSwitchCurtain: React.FC = () => {
  const { t } = useI18n('common');
  const intent = useDeviceOpenIntent(state => (state.intent && needsCurtain(state.intent.key) ? state.intent : null));
  const [phase, setPhase] = useState<Phase>(intent ? 'covering' : 'hidden');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const timers = useRef<{ frame: number; timer: ReturnType<typeof setTimeout> | null }>({ frame: 0, timer: null });

  useEffect(() => {
    const pending = timers.current;
    cancelAnimationFrame(pending.frame);
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    if (intent) {
      phaseRef.current = 'covering';
      setPhase('covering');
      return;
    }
    if (phaseRef.current === 'hidden') return;
    // Two frames: the scene the open committed has rendered and painted.
    pending.frame = requestAnimationFrame(() => {
      pending.frame = requestAnimationFrame(() => {
        setPhase('leaving');
        pending.timer = setTimeout(() => setPhase('hidden'), DEVICE_SWITCH_CURTAIN_LEAVE_MS);
      });
    });
  }, [intent]);

  useEffect(() => () => {
    cancelAnimationFrame(timers.current.frame);
    if (timers.current.timer !== null) clearTimeout(timers.current.timer);
  }, []);

  if (phase === 'hidden') return null;
  return (
    <div className="openbitfun-device-switch-curtain" data-phase={phase} data-testid="device-switch-curtain"
      data-openbitfun-component="device-switch-curtain" data-openbitfun-part="root"
      role="status" aria-busy={phase === 'covering'} aria-label={t('loading.scenes')}>
      <div className="openbitfun-device-switch-curtain__spinner" data-openbitfun-component="device-switch-curtain" data-openbitfun-part="spinner"><Spinner size="md" /></div>
    </div>
  );
};
