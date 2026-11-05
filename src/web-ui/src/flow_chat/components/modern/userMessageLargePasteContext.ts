import React from 'react';

export interface UserMessageLargePasteContextValue {
  largePastes: Readonly<Record<string, string>> | null;
  openLargePaste: (placeholder: string) => void;
}

/** Stored large paste bodies of the message being rendered, if any. */
export const UserMessageLargePasteContext = React.createContext<UserMessageLargePasteContextValue | null>(null);
