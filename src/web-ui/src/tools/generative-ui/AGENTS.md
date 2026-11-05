# GenUI

The target architecture and ownership boundaries are defined in
[`docs/architecture/generative-ui-architecture.md`](../../../../../docs/architecture/generative-ui-architecture.md).
It is the single GenUI architecture document. Do not create parallel Canvas,
Widget, or component-app architecture guides.

GenUI has two explicit source types: OpenUI Lang composed from trusted product
components, and isolated HTML/CSS/SVG with optional controlled JavaScript. They
share application identity, source and state revisions, owner persistence,
candidate acceptance, evidence, and remote ownership. Their parsers and renderers
remain separate. Model-generated TSX, per-app compilation, the old JSON
expression/workflow runtime, and conversion between these languages are not
target paths.

For the component path, use OpenUI `lang-core` and `react-lang` semantics. Product
library declarations own component schemas, descriptions, composition and
trusted renderers; templates are optional. Do not copy OpenUI parser behavior or
maintain a second component-generation contract. Every library revision is pinned
to an application revision. Component probes inspect only their owned DOM and run
against isolated state without persistence or external side effects.

For free documents, never run candidate scripts while streaming or previewing.
Use a sandboxed opaque-origin document; script execution requires an explicit
owner `htmlBridge`, `allow-scripts` without `allow-same-origin`, a restrictive
content policy, structured HTML/SVG sanitization, and an owner-bound,
schema-checked capability bridge. Do not expose
Tauri, Node, credentials, direct filesystem access, or generic network access to
the document. An iframe is not a CPU or memory sandbox: hosts that cannot prove
the required isolation must explicitly disable generated JavaScript while still
allowing static documents. Never reuse the old Widget frame unchanged.

The application owner alone controls durable source/state revisions and accepts
candidates by compare-and-swap. Check the actual render, declared interactions,
isolated save/reopen and applicable requirement evidence. Failed or unavailable
stages stay visible. Preserve unknown and unsupported stored data without reset;
format/library changes are explicit revisions.

The focused commands below cover the current implementation during migration;
they do not prove that OpenUI action/query bridges or free-document JavaScript
isolation are complete on every native host.

Run from repository root:

    node scripts/generate-genui-contract.mjs --check
    pnpm --dir src/web-ui exec node scripts/run-vitest.mjs run src/tools/generative-ui src/tools/generative-widget/GenerativeWidgetPanel.test.tsx src/flow_chat/utils/generativeWidgetProjection.test.ts src/flow_chat/services/flow-chat-manager/PersistenceModule.test.ts src/flow_chat/services/FlowChatManager.test.ts --maxWorkers=50%
    pnpm run check:web

For shared schema or tool changes:

    cargo test --locked -p openbitfun-product-domains --no-default-features --lib generative_ui
    cargo test --locked -p openbitfun-services-integrations --no-default-features --features generative-ui --lib generative_ui
    cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,tools-miniapp,git --lib -- generative_ui tool_task_context_materialization_preserves_runtime_fields

For real browser layout, event dispatch and fixture-storage reload, start Vite
from this checkout with free HTTP/HMR ports, then run:

    OPENBITFUN_DEV_PORT=1430 OPENBITFUN_DEV_HMR_PORT=1429 pnpm --dir src/web-ui exec vite --host 127.0.0.1
    OPENBITFUN_GENUI_TEST_URL=http://127.0.0.1:1430/tests/e2e/generative-ui.html node scripts/test-genui-browser.mjs

The runner uses the installed E2E Puppeteer dependency and Chrome, or CHROME_PATH.
OPENBITFUN_GENUI_SCREENSHOT_DIR optionally retains actual host probe images.
The fixture replaces locale/storage ports only; it does not start another app.

These fixtures exercise DOM, library replacement, source ownership, persistence
acknowledgements/readback and simulated surface changes. They do not establish
native dev WebView, free-document script isolation, live model review/repair or
live remote behavior. OpenUI action and query plumbing is covered only when a
test supplies an explicit owner callback/provider; absence of those capabilities
must remain unsupported. Do not substitute the release application window for
openbitfun-desktop during manual validation.

Selectable library profiles and generated schemas remain in library.json/catalog.json.
New component documents use `source.kind = openui-lang`; source documents are the
only generation and delivery path. Graph messages and the graph renderer are
removed, so a source-less record is rejected and must be regenerated explicitly.
Do not add profiles that only change styling.
Previews use disposable state and no persistence. Track vendored source and
license boundaries in components/vendor/README.md.

The runtime emits native `GenUIStream` events. Each event carries decoded
OpenUI Lang text, a monotonic sequence number, and a reset marker; FlowChat
stores that source stream separately from tool-call JSON framing. GenUI
projection must consume this native stream directly and must not reconstruct
OpenUI source from `ParamsPartial` fragments.

For selection, failed reads/saves, unknown profiles, device changes and negotiated
peer settings, also run:

    pnpm --dir src/web-ui exec node scripts/run-vitest.mjs run src/app/scenes/settings/pages/ai/GenUILibrarySection.test.tsx src/infrastructure/api/adapters/peer-device-adapter.test.ts --maxWorkers=50%

The browser runner covers current profiles, the settings picker, disposable
preview edits and persisted selection after reload. Host IO is replaced in this
fixture; it does not establish native dev or live remote acceptance.

It also feeds native/deferred source arguments through ToolEventModule and the
production store, projection and panel. Assert source availability only after a
complete source message, explicit rejection of graph operations, and stable owner
state. OpenUI's parser owns language streaming; do not recreate a second graph
runtime. Component inspect must stay inside its own renderer boundary, including
optional props on nested cards.
