/** Keep advertised targets mounted until the native drop reaches React. */
export function observeTabDragLifecycle(onStart: (event: DragEvent) => void, onEnd: () => void): () => void {
  let pendingDrop: ReturnType<typeof setTimeout> | undefined;
  const cancelPendingDrop = () => {
    clearTimeout(pendingDrop);
    pendingDrop = undefined;
  };
  const start = (event: DragEvent) => {
    cancelPendingDrop();
    onStart(event);
  };
  const end = () => {
    cancelPendingDrop();
    onEnd();
  };
  const drop = () => {
    cancelPendingDrop();
    // Capture also sees drops that another target stops from bubbling. Do not
    // remove their DOM here: native listeners can flush React before its root
    // receives the event. A task (not a microtask) runs after that dispatch.
    pendingDrop = setTimeout(end, 0);
  };
  window.addEventListener('dragstart', start);
  window.addEventListener('dragend', end, true);
  window.addEventListener('drop', drop, true);
  return () => {
    cancelPendingDrop();
    window.removeEventListener('dragstart', start);
    window.removeEventListener('dragend', end, true);
    window.removeEventListener('drop', drop, true);
  };
}
