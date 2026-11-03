import { useEffect } from 'react';
import { startWindowResizeLayout } from './windowResizeScheduler';

/** Scheduling only: retain the live page and its normal input/paint behavior. */
export function WindowResizeLayout() {
  useEffect(startWindowResizeLayout, []);
  return null;
}
