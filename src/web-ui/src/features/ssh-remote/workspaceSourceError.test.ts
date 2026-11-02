import { expect, it } from 'vitest';
import { isSshAuthenticationError, workspaceSourceErrorKey } from './workspaceSourceError';

it.each([
  ["Error: Failed to start local Docker executable 'docker'", 'workspaceSource.dockerUnavailable'],
  ['Cannot connect to the Docker daemon', 'workspaceSource.dockerNotRunning'],
  ['docker: permission denied', 'workspaceSource.dockerPermissionDenied'],
  ['unexpected process failure', 'workspaceSource.containerDiscoveryFailed'],
  ['Host does not support this environment', 'workspaceSource.sourceUnsupported'],
])('translates Docker diagnostics into actionable copy: %s', (message, key) => {
  expect(workspaceSourceErrorKey('localDocker', new Error(message))).toBe(key);
});

it('requests credentials for authentication failures rather than network or native-process failures', () => {
  expect(isSshAuthenticationError(new Error('SSH password is required (no saved password for this connection)'))).toBe(true);
  expect(isSshAuthenticationError(new Error('Credentials required'))).toBe(true);
  expect(isSshAuthenticationError(new Error('connection refused'))).toBe(false);
  expect(isSshAuthenticationError(new Error("Failed to start local Docker executable 'docker'"))).toBe(false);
});
