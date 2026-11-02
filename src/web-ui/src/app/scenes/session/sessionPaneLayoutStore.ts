/** Compatibility exports for existing panel adapters and settings contracts. */
export {
  createWorkbenchPaneLayoutStore as createSessionPaneLayoutStore,
  workbenchPaneLayoutStore as sessionPaneLayoutStore,
  selectWorkbenchPaneMode as selectSessionPaneMode,
  useWorkbenchPaneLayout as useSessionPaneLayout,
  projectLegacySessionPaneLayout,
} from '../../workbench/workbenchPaneLayoutStore';
export type {
  WorkbenchPaneLayoutStore as SessionPaneLayoutStore,
  LegacySessionPaneLayout, SessionPaneMode, ContentPaneSide, SessionPaneDisplayMode,
} from '../../workbench/workbenchPaneLayoutStore';
