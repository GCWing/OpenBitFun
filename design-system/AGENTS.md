# AGENTS.md

## Scope

This file applies to `design-system/**`. Repository-wide rules in the root `AGENTS.md` still apply.

## Architecture

- Public packages live under `packages/`; private authoring and validation tools live under `tooling/`; Design Lab lives under `apps/`.
- `@openbitfun/ui` owns React anatomy, behavior, accessibility, and stable variants. It must remain independent from product routes, stores, locale catalogs, Tauri APIs, and concrete themes.
- `@openbitfun/design-tokens` owns theme-independent names and system scales. `@openbitfun/theme-openbitfun` supplies replaceable reference and semantic values.
- Components consume semantic or system CSS variables. Raw colors are forbidden in public component CSS. Component-private variables use the `--_` prefix.
- Floating surfaces use the document overlay coordinator through `Portal`. Opening order owns global ranks; keep `open` through retained exits and declare `ownerRef` for sibling/coordinate child portals. Modal focus, inert state and dismissal must use the same owner. Notification layout regions remain neutral, with one `OverlayLayer` per card. See the UI README overlay contract.
- Menu and Listbox row spacing is owned by `overlay.menu.rowGap`, separately from in-row and section spacing. Use `MenuList` around menu rows inside custom scroll/animation wrappers; do not repair individual consumers with row margins or private list-gap overrides.
- Single-line text slots use `OverflowText`: plain text defaults to fade-out truncation plus an interaction marquee; rich composition keeps its layout unless explicitly opted in. Keep icons/actions outside the text slot, mark the owning control with `data-overflow-trigger`, and preserve wrapping or native editing where appropriate. See the UI package README for the shared interaction contract.
- Files under `dist/` are generated and must not be edited or committed.
- Design Lab may alias `@openbitfun/ui` to source only during Vite development for HMR. Its production build must consume package exports.
- `@openbitfun/ui/registry` is the source of truth for published components. Design Lab derives navigation, counts, token scopes, and detail routes from that registry; Lab-only previews or copy must never add, retain, or remove a package component.

## CSS invalidation

- Prefer component-owned classes for sibling rules in dynamic views; tag-only or universal sibling selectors can invalidate unrelated elements even under a scoped ancestor or CSS Module.
- Use layout `gap` only where spacing semantics remain equivalent. Preserve adjacency, specificity, and state overrides when narrowing selectors; `:where()` can add class constraints without raising specificity.
- Use Selector Stats for cause analysis and ordinary traces for performance comparisons. Invalidation records alone do not prove a scrolling speedup. See `src/web-ui/AGENTS.md` for generated-content guidance; do not blanket-ban sibling selectors.

## Publication boundary

- Public manifests expose only `dist/`, README, and package metadata.
- React and React DOM stay peer dependencies of `@openbitfun/ui`.
- Workspace dependencies use the `workspace:` protocol and must be converted to semver ranges by `pnpm pack`.
- New public package boundaries require a real consumer; do not create empty placeholder packages.

## Verification

Use the narrowest matching command:

```bash
pnpm run design-system:build
pnpm run design-system:test
pnpm run design-system:check
```

Run `pnpm run design-system:check` for cross-package or release-boundary changes. Token and theme changes must also run the repository-level `pnpm run theme:color-audit:all`.

Do not use browser automation or mock screenshots as visual proof. Design Lab is the manual authoring surface; source, build, HTTP, and package checks do not establish final visual fidelity.
