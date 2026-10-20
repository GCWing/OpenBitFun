 

export * from './GlobalMenuProvider';
export * from './SelectionMenuProvider';
export * from './TextInputMenuProvider';
export * from './EditorMenuProvider';
export * from './FileExplorerMenuProvider';
export * from './FlowChatMenuProvider';
export * from './TerminalMenuProvider';

import { GlobalMenuProvider } from './GlobalMenuProvider';
import { SelectionMenuProvider } from './SelectionMenuProvider';
import { TextInputMenuProvider } from './TextInputMenuProvider';
import { EditorMenuProvider } from './EditorMenuProvider';
import { FileExplorerMenuProvider } from './FileExplorerMenuProvider';
import { FlowChatMenuProvider } from './FlowChatMenuProvider';
import { TerminalMenuProvider } from './TerminalMenuProvider';
import { IMenuProvider } from '../types/provider.types';

 
export function getBuiltinProviders(): IMenuProvider[] {
  return [
    new GlobalMenuProvider(),
    new SelectionMenuProvider(),
    new TextInputMenuProvider(),
    new EditorMenuProvider(),
    new FileExplorerMenuProvider(),
    new FlowChatMenuProvider(),
    new TerminalMenuProvider()
  ];
}

