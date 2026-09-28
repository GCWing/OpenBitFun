import { useRef, type HTMLAttributes } from 'react';
import { classNames } from '../../internal/classNames';
import egg from '../assets/subagent-egg.svg?raw';
import { useSubagentHatchMotion, type SubagentHatchPhase } from './subagentHatchMotion';
import styles from './SubagentHatch.module.css';

export interface SubagentHatchProps extends HTMLAttributes<HTMLSpanElement> {
  phase: SubagentHatchPhase;
  size?: number;
  active?: boolean;
  label?: string;
}

/** Applications provide the real avatar as children and own creation/error state. */
export function SubagentHatch({ phase, size, active = true, label, children, className, style, ...props }: SubagentHatchProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useSubagentHatchMotion(ref, phase, active);
  return <span {...props} ref={ref} className={classNames(styles.root, className)}
    style={{ width: size, height: size, ...style }}
    data-openbitfun-component="subagent-hatch" data-openbitfun-part="root" data-phase={phase}
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <span className={styles.avatar} data-hatch-part="avatar" aria-hidden="true">{children}</span>
    <span className={styles.shell} data-hatch-part="shell" aria-hidden="true" dangerouslySetInnerHTML={{ __html: egg }} />
  </span>;
}
