import type { ReactElement } from 'react';
import { Tooltip } from '@openbitfun/ui';
import styles from './MiniAppActionTooltip.module.css';

/** Top-bar hints remain discoverable when the native button is disabled. */
export function MiniAppActionTooltip({ content, disabled = false, children }: {
  content: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  return <Tooltip content={content} placement="bottom" trigger="hover-focus" delay={150}>
    {disabled ? <span className={styles.disabledTrigger} role="group" tabIndex={0}
      aria-label={content} aria-disabled="true"
      data-openbitfun-scene="miniapp" data-openbitfun-part="actionHint"
      onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {children}
    </span> : children}
  </Tooltip>;
}
