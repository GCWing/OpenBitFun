import { createContext, useContext } from "react";

export type FieldSurface = "ambient" | "default" | "filled";

export const FieldSurfaceContext = createContext<FieldSurface>("default");

export function useFieldSurface(): FieldSurface {
  return useContext(FieldSurfaceContext);
}
