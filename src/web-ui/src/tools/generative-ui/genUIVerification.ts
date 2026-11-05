import type { GenUIAppState } from './genUITypes';
import type { GenUIContractIssue } from './genUIContract';
import type { OpenUIError } from '@openuidev/lang-core';
export interface GenUIVerification {
  appId?: string;
  definitionKey: string;
  checks?: 'unverified' | 'passed' | 'failed';
  state: GenUIAppState;
  preflight: 'unverified' | 'passed' | 'failed';
  render: 'unverified' | 'passed' | 'failed';
  interaction: 'unverified' | 'observed' | 'failed';
  persistence: 'unverified' | 'saving' | 'saved' | 'failed';
  reopen: 'unverified' | 'restored';
  issues: GenUIContractIssue[];
  diagnostics?: OpenUIError[];
}
