import { createContext, useContext } from 'react';

/** Shared pane geometry belongs to the workbench, including scenes in either slot. */
export const WorkbenchResizeContext = createContext({
  resizing: false,
  measurementSuspended: false,
});

export function useWorkbenchResize() {
  return useContext(WorkbenchResizeContext);
}
