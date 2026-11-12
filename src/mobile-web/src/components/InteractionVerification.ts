import { createContext } from 'react';

/**
 * Re-read the host's view of pending interactions (session stream and
 * interaction mailbox) and resolve once it has answered or given up. An
 * approval or answer whose reply was lost is only reported as "not confirmed"
 * after this check still shows it pending.
 */
export const InteractionVerifyContext = createContext<(() => Promise<void>) | null>(null);

/** Question tool IDs the interaction mailbox renders; the transcript defers to it. */
export const MailboxQuestionOwnerContext = createContext<ReadonlySet<string>>(new Set());
