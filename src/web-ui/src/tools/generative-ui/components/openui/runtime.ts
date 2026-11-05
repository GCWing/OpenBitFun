import { createContext, useContext } from "react";
import type { GenUIAsyncRuntime } from "../../genUIAsyncCapabilities";

/** Host capabilities exposed to the vendored Open Intelligent UI components. */
export const OpenUIAsyncRuntimeContext = createContext<GenUIAsyncRuntime | undefined>(undefined);

export function useOpenUIAsyncRuntime(): GenUIAsyncRuntime | undefined {
  return useContext(OpenUIAsyncRuntimeContext);
}
