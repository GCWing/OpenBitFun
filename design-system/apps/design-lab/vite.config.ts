import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createTokenAuthoringPlugin } from "./vite/token-authoring-plugin.mjs";
import { watchSourcePlugin } from "../../tooling/vite/watch-source.mjs";

const labDirectory = path.dirname(fileURLToPath(import.meta.url));
const designSystemDirectory = path.resolve(labDirectory, "../..");
const uiSourceDirectory = path.join(designSystemDirectory, "packages/ui/src");
const flowChatPresentationDirectory = path.resolve(designSystemDirectory, "../packages/flow-chat-presentation");
const brandExportsDirectory = path.resolve(designSystemDirectory, "../assets/brand/exports");
const brandWordmarkFile = path.resolve(designSystemDirectory, "../png/openbitfun-wordmark.png");
const subagentIdentityDirectory = path.resolve(designSystemDirectory, "../src/web-ui/src/flow_chat/subagent-identity");
const subagentArtworkDirectory = path.resolve(designSystemDirectory, "../src/web-ui/src/flow_chat/assets/subagent-avatars");

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    watchSourcePlugin(uiSourceDirectory),
    watchSourcePlugin(flowChatPresentationDirectory),
    watchSourcePlugin(subagentArtworkDirectory),
    createTokenAuthoringPlugin({ designSystemDirectory }),
  ],
  resolve: {
    dedupe: ["react", "react-dom", "lucide-react"],
    alias:
      command === "serve"
        ? [
            {
              find: /^@openbitfun\/ui\/brand$/,
              replacement: path.join(uiSourceDirectory, "brand.ts"),
            },
            {
              find: /^@openbitfun\/ui\/flow-chat$/,
              replacement: path.join(uiSourceDirectory, "flow-chat.ts"),
            },
            {
              find: /^@openbitfun\/ui\/registry$/,
              replacement: path.join(uiSourceDirectory, "registry.ts"),
            },
            {
              find: /^@openbitfun\/ui\/styles\.css$/,
              replacement: path.join(uiSourceDirectory, "styles/layers.css"),
            },
            {
              find: /^@openbitfun\/ui$/,
              replacement: path.join(uiSourceDirectory, "index.ts"),
            },
          ]
        : [],
  },
  optimizeDeps: {
    exclude: [
      "@openbitfun/design-tokens",
      "@openbitfun/theme-openbitfun",
      "@openbitfun/ui",
    ],
  },
  server: {
    fs: {
      allow: [brandExportsDirectory, brandWordmarkFile, designSystemDirectory, subagentIdentityDirectory, subagentArtworkDirectory, flowChatPresentationDirectory],
    },
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
}));
