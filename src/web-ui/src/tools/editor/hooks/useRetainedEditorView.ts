import { useLayoutEffect, useRef, useState } from 'react';
import { editorViewResidency } from '../services/editorViewResidency';

/** Call only when the owner can preserve document and undo state without a view. */
export function useRetainedEditorView(active: boolean): boolean {
  const key = useRef({});
  const [resident, setResident] = useState(active);
  useLayoutEffect(() => {
    const viewKey = key.current;
    if (active) setResident(true);
    editorViewResidency.update(viewKey, active, () => setResident(false));
    return () => editorViewResidency.delete(viewKey);
  }, [active]);
  return active || resident;
}
