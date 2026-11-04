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
 *
 * "One workspace moved to the front" is judged against the shown order and
 * against the host's own last order. While a device is rendered its catalog is
 * not re-read, so an older host can collect several activations between two
 * reads; comparing only with the shown order took that drift for a deliberate
 * arrangement, and the live list and the catalog then kept adopting each
 * other's order on every switch. The host order is therefore remembered too,
 * and activations this window asks for are applied to it the way an older
 * host applies them (`noteWorkspaceActivated`).
 */

const orders = new Map<string, readonly string[]>();
/** The host's own order as last seen, with this window's activations applied. */
const hostOrders = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
let revision = 0;

const sameIds = (left: readonly string[], right: readonly string[]) => (
  left.length === right.length && left.every((id, index) => id === right[index])
);

export function setWorkspaceDisplayOrder(surfaceId: string, workspaceIds: readonly string[]): void {
  const previous = orders.get(surfaceId);
  orders.set(surfaceId, [...workspaceIds]);
  if (previous && sameIds(previous, workspaceIds)) return;
  revision += 1;
  for (const listener of Array.from(listeners)) listener();
}

/** Changes whenever a surface's display order changes (for `useSyncExternalStore`). */
export function getWorkspaceDisplayOrderRevision(): number {
  return revision;
}

export function subscribeWorkspaceDisplayOrder(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * This window activated `workspaceId` on the surface's host. An older host
 * moves it to the front of its opened list; a newer one keeps its place, which
 * still matches the shown order.
 */
export function noteWorkspaceActivated(surfaceId: string, workspaceId: string): void {
  const host = hostOrders.get(surfaceId);
  if (!host?.includes(workspaceId)) return;
  hostOrders.set(surfaceId, [workspaceId, ...host.filter(id => id !== workspaceId)]);
}

export function stableWorkspaceOrder<T extends { id: string }>(surfaceId: string, hostWorkspaces: readonly T[]): T[] {
  const remembered = orders.get(surfaceId);
  const hostIds = hostWorkspaces.map(workspace => workspace.id);
  if (!remembered) {
    setWorkspaceDisplayOrder(surfaceId, hostIds);
    hostOrders.set(surfaceId, hostIds);
    return [...hostWorkspaces];
  }
  // Both sides restricted to the workspaces they share.
  const common = (previous: readonly string[]) => [
    previous.filter(id => hostIds.includes(id)), hostIds.filter(id => previous.includes(id)),
  ] as const;
  const [shown, listed] = common(remembered);
  const lastHost = hostOrders.get(surfaceId);
  if (!isActivationReorder(shown, listed) && !(lastHost && isActivationReorder(...common(lastHost)))) {
    setWorkspaceDisplayOrder(surfaceId, hostIds);
    hostOrders.set(surfaceId, hostIds);
    return [...hostWorkspaces];
  }
  // A list already in the shown order says nothing about the host (the live
  // list passes the order it shows on activation); keep the host order seen last.
  if (!sameIds(shown, listed)) hostOrders.set(surfaceId, hostIds);
  const result = mergeIntoOrder(remembered, hostWorkspaces);
  setWorkspaceDisplayOrder(surfaceId, result.map(workspace => workspace.id));
  return result;
}

/**
 * `workspaces` in the surface's remembered order, without changing it. For
 * lists read earlier (a cached catalog, the last live list) that must look the
 * same as the list now shown for the device.
 */
export function orderWorkspacesForDisplay<T extends { id: string }>(surfaceId: string, workspaces: readonly T[]): T[] {
  const remembered = orders.get(surfaceId);
  return remembered ? mergeIntoOrder(remembered, workspaces) : [...workspaces];
}

/** `remembered` order of `hostWorkspaces`; new ones keep the host's place among their neighbours. */
function mergeIntoOrder<T extends { id: string }>(remembered: readonly string[], hostWorkspaces: readonly T[]): T[] {
  const byId = new Map(hostWorkspaces.map(workspace => [workspace.id, workspace]));
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
  return result;
}

/** `host` equals `shown`, or is `shown` with one workspace moved to the front. */
function isActivationReorder(shown: readonly string[], host: readonly string[]): boolean {
  if (shown.length !== host.length) return false;
  if (sameIds(shown, host)) return true;
  const moved = host[0];
  const rest = shown.filter(id => id !== moved);
  return rest.every((id, index) => id === host[index + 1]);
}

export function resetWorkspaceDisplayOrdersForTest(): void {
  orders.clear();
  hostOrders.clear();
}
