import type { GenUIAppState } from './genUITypes';
import type { GenUIContractIssue } from './genUIContract';
export interface GenUIVerification {
  definitionKey: string;
  checks?: 'unverified' | 'passed' | 'failed';
  state: GenUIAppState;
  preflight: 'unverified' | 'passed' | 'failed';
  render: 'unverified' | 'passed' | 'failed';
  interaction: 'unverified' | 'observed' | 'failed';
  persistence: 'unverified' | 'saving' | 'saved' | 'failed';
  reopen: 'unverified' | 'restored';
  issues: GenUIContractIssue[];
}
