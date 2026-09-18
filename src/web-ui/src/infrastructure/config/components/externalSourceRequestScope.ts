interface ExternalSourceRequestScopeFacts {
  peerDeviceId?: string;
  workspaceId?: string;
  workspaceKind?: string;
  remoteConnectionId?: string;
  remoteHost?: string;
  workspacePath?: string;
}

/**
 * Keeps view state and async results bound to the Host that owns the facts.
 * This key is frontend-only; Host identity must not leak into the public
 * external-source snapshot contract.
 */
export function externalSourceRequestScopeKey(
  facts: ExternalSourceRequestScopeFacts,
): string {
  return JSON.stringify({
    host: facts.peerDeviceId ? `peer:${facts.peerDeviceId}` : 'local',
    workspaceId: facts.workspaceId ?? null,

  });
}
