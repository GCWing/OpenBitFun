# MiniApp Agent Surface

This module owns frame-local DOM observations and input, capability reporting,
and routing to the existing MiniApp instance. Keep native desktop input in the
Desktop adapter; never substitute another frame or device for an unavailable
target. Positioned clicks require the advertised `element-position-click-v1`
capability, while ordinary element clicks remain compatible with older hosts.

For DOM input, surface routing, and business behavior:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/agent/miniAppAgentDomRuntime.test.ts src/app/scenes/miniapps/agent/miniAppAgentRouter.test.ts src/app/scenes/miniapps/agent/miniAppAgentBusiness.test.ts
```

The business fixture runs the real app and injected SDK. Its legacy Gomoku case
verifies SVG input and the resulting AI move without a semantic bridge, source
changes, or reload. jsdom supplies the frame layout and transport; this does not
prove native WebView rendering, live-model tool selection, or remote scenarios.
For production Web UI changes, also run `pnpm run check:web` per the parent guide.
