"use client";

import { useEffect, useState, type RefObject } from "react";

/** Read the active host color-scheme and refresh when its Appearance mode changes. */
export function useColorScheme(ref: RefObject<HTMLElement | null>): "light" | "dark" {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const read = () => {
      const value = ref.current ? getComputedStyle(ref.current).colorScheme : "";
      setScheme(value.trim() === "dark" ? "dark" : "light");
    };
    read();
    // Appearance switches the mode on the document root.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-openbitfun-appearance-mode", "data-theme"] });
    return () => observer.disconnect();
  }, [ref]);
  return scheme;
}
