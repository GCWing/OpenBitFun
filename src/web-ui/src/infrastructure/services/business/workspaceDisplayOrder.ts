/**
 * One display order of opened workspaces per device surface.
 *
 * Hosts before this change move a workspace to the front of their opened list
 * whenever it becomes active, so every re-read (a device switch, a catalog
 * refresh, another controller's activation) could reorder the sidebar. The
 * window keeps the order it last showed for each device and applies it to
 * every host list, live or background, so both projections of a device agree
 * and activation never moves a row. Workspaces new to the list keep the place
 * the host gave them relative to their neighbours; an explicit reorder
 * replaces the order. A host order that differs by more than one workspace
 * moved to the front was arranged on purpose (a reorder on another
 * controller), so the window adopts it.
 */

const orders = new Map<string, readonly string[]>();

export function setWorkspaceDisplayOrder(surfaceId: string, workspaceIds: readonly string[]): void {
  orders.set(surfaceId, [...workspaceIds]);
}

export function stableWorkspaceOrder<T extends { id: string }>(surfaceId: string, hostWorkspaces: readonly T[]): T[] {
  const remembered = orders.get(surfaceId);
  if (!remembered) {
    setWorkspaceDisplayOrder(surfaceId, hostWorkspaces.map(workspace => workspace.id));
    return [...hostWorkspaces];
  }
  const byId = new Map(hostWorkspaces.map(workspace => [workspace.id, workspace]));
  if (!isActivationReorder(remembered.filter(id => byId.has(id)),
    hostWorkspaces.map(workspace => workspace.id).filter(id => remembered.includes(id)))) {
    setWorkspaceDisplayOrder(surfaceId, hostWorkspaces.map(workspace => workspace.id));
    return [...hostWorkspaces];
  }
  const result: T[] = remembered.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
  const placed = new Set(result.map(workspace => workspace.id));
  hostWorkspaces.forEach((workspace, hostIndex) => {
    if (placed.has(workspace.id)) return;
    // Before every shown workspace the host lists after it, else at the end.
    const after = new Set(hostWorkspaces.slice(hostIndex + 1).map(candidate => candidate.id));
    const first = result.findIndex(candidate => after.has(candidate.id));
    const index = first === -1 ? result.length : first;
    result.splice(index, 0, workspace);
    placed.add(workspace.id);
  });
  setWorkspaceDisplayOrder(surfaceId, result.map(workspace => workspace.id));
  return result;
}

/** `host` equals `shown`, or is `shown` with one workspace moved to the front. */
function isActivationReorder(shown: readonly string[], host: readonly string[]): boolean {
  if (shown.length !== host.length) return false;
  if (shown.every((id, index) => id === host[index])) return true;
  const moved = host[0];
  const rest = shown.filter(id => id !== moved);
  return rest.every((id, index) => id === host[index + 1]);
}

export function resetWorkspaceDisplayOrdersForTest(): void {
  orders.clear();
}
