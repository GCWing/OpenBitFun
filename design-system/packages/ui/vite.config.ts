import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    cssCodeSplit: false,
    lib: {
      cssFileName: "styles",
      entry: {
        brand: path.resolve(packageDirectory, "src/brand.ts"),
        "flow-chat": path.resolve(packageDirectory, "src/flow-chat.ts"),
        index: path.resolve(packageDirectory, "src/index.ts"),
        registry: path.resolve(packageDirectory, "src/registry.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
      ],
      output: {
        entryFileNames: "[name].js",
      },
    },
    sourcemap: true,
  },
});
