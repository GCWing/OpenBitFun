# OpenBitFun Design System

This directory is an independently buildable and publishable design-system boundary inside the OpenBitFun monorepo.

It deliberately does not depend on Web UI routes, stores, locale catalogs, Tauri APIs, or product-domain state. Applications consume only package exports.

## Packages

- `@openbitfun/design-tokens`: token contract, system scales, density modes, and generated CSS/TypeScript artifacts.
- `@openbitfun/theme-openbitfun`: replaceable OpenBitFun light, dark, and high-contrast theme values.
- `@openbitfun/ui`: theme-independent React primitives and components.
- `@openbitfun/token-engine`: private build-time token resolver shared by packages and authoring tools.
- `@openbitfun/design-lab`: private standalone preview and token-authoring application.

The OpenBitFun theme uses a two-layer color model. Foundational colors use named numeric scales such as `ref.color.neutral.50` and `ref.color.blue.500`; mode-specific semantic colors map those values to UI roles. Reference colors are available to authoring tools as data, but emit no runtime CSS variables and are never a component styling contract.

Design Lab exposes an Overview, a searchable component catalog with interactive component-detail workbenches, a Design Tokens workbench for non-color contracts, and a dedicated Colors reference page. Colors reads the generated semantic theme catalog and foundational reference scales directly from `@openbitfun/theme-openbitfun`, compares Light, Dark, High Contrast Light, and High Contrast Dark values in one table, and documents scale, palette, and resolved mapping relationships without duplicating source values. The Design Tokens workbench keeps typography, spacing, geometry, motion, layer, opacity, and shadow authoring separate, combines a selectable token table with a focused inspector, renders token-driven previews, and can filter the catalog by component ownership. Edits are scoped to the active density and theme modes, update the effect preview immediately, persist as a local draft, and can be exported. In local development, its loopback-only authoring bridge validates changes, writes the owning token source document, rebuilds the package, and rolls back the source if validation fails.

`@openbitfun/ui/registry` is the component source of truth. Design Lab derives its component navigation, counts, token scopes, and detail routes from that package export; adding Lab copy or a preview cannot publish a component or keep a removed component alive.

The **Patterns** page composes public controls into settings, navigation,
search/actions, device cards, provider configuration, scene toolbars, and nested
command menus. The provider specimen includes an actual modal interaction demo,
model multi-selection/custom values and expandable detail cards. The toolbar
supports tab selection, closing and addition; the command menu supports both
button and right-click entry with nested keyboard and pointer navigation.
These are local interaction previews: they do not call product APIs or save
credentials.
Review these manually in light/dark, high-contrast and density modes; build and
interaction checks do not establish pixel-level visual fidelity.

The same entry publishes `ChatComposer`, the shared context-band and
compact/expanded input anatomy used by product composers without importing
their stores, localized menus, editor, model, voice, or host actions.

`SetupWizard` publishes the guided configuration pattern used by agent creation:
a split header, tinted explanatory pane, one current-step indicator, form/editor
viewport and footer actions. It supports any consumer-controlled sequence and
stacks by available container width. Design Lab includes a working three-stage
example; the [UI package guide](packages/ui/README.md#guided-configuration)
documents validation, localized guidance, dialog labelling and scroll ownership.

FlowChat tool-card frameworks are published from `@openbitfun/ui/flow-chat` as
`AmbientToolCard` and `ProminentToolCard`. The names describe whether a tool
result should stay in the conversational background or receive deliberate user
attention. Concrete package views cover the reusable FlowChat families for file
and command execution, search and web results, agent and session activity, Git
and review summaries, page lifecycle, code execution, todos, images, and other
routine tool traces. Product adapters continue to own parsing, stores,
localization, host capabilities, and heavy renderers passed through semantic
slots; the package owns each migrated card's anatomy, state presentation, and
interaction structure.

Design Lab exposes FlowChat as its own library category. Both framework and
tool-view entries come from `@openbitfun/ui/registry`; its typed preview registry is
exhaustive over those package entries. The tool gallery renders only real
public views used by migrated adapters and lists bespoke product cards
separately instead of substituting generic previews for them.

## Commands

```bash
pnpm run design-system:dev
pnpm run design-system:build
pnpm run design-system:test
pnpm run design-system:check
```

The Design Lab development entry uses source aliases for component HMR. Its production build consumes the public package exports, so authoring convenience cannot silently become the published contract.

Design Lab and Web UI also register `tooling/vite/watch-source.mjs` to watch
the aliased UI source directory outside their application roots. Source aliases
alone do not watch imported SVG assets: without this registration an icon edit
can leave the previous inline asset module cached until the dev server restarts.

## Dependency direction

```text
token-engine -> design-tokens -> theme-openbitfun
design-tokens -------------> ui
design-tokens + theme-openbitfun + ui -> design-lab
```

`@openbitfun/ui` never depends on a concrete theme. A consumer imports a theme package and UI styles separately.
