import { createContext, useContext, type ReactNode } from 'react';
import styles from './FlowChatToolCard.module.css';
import type { FlowChatToolStatus } from './FlowChatToolCard';

export interface ToolCapsulePresentation {
  label: string;
  /** Localized type, full target and state, also available to keyboard users. */
  description: string;
  statusLabel: string;
  countLabel?: string;
  status: FlowChatToolStatus;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Used only when the existing card has neither details nor a direct action. */
  fallbackContent?: ReactNode;
}

const ToolCapsuleContext = createContext<ToolCapsulePresentation | undefined>(undefined);

/** Opt-in composition for explicitly lightweight tools; prominent cards ignore it. */
export function ToolCapsulePresentationProvider({
  value, children,
}: { value?: ToolCapsulePresentation; children: ReactNode }) {
  return <ToolCapsuleContext.Provider value={value}>{children}</ToolCapsuleContext.Provider>;
}

export function useToolCapsulePresentation() {
  return useContext(ToolCapsuleContext);
}

/** Supporting record for lightweight cards which have no specialized detail body. */
export function ToolCapsuleDetails({ fields, error }: {
  fields: readonly { label: string; value: string }[];
  error?: string;
}) {
  return <div className={styles.capsuleDetails}>
    {error && <p className={styles.error}>{error}</p>}
    {fields.map((field, index) => <section key={index}>
      <div className={styles.capsuleDetailLabel}>{field.label}</div>
      <pre>{field.value}</pre>
    </section>)}
  </div>;
}
