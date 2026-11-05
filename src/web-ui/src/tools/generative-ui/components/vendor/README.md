# GenUI library sources

The product compiles selected subsets into its declarative contract. OpenUI Lang
profiles share the parser and renderer, while each profile owns its library,
adapter and style resources. No generated TSX, iframe, Tailwind global reset or
dynamic code loader is imported.

- Open Intelligent UI (`openui`): the upstream `open-intelligent-ui` library
  is vendored from `task_genui/open-intelligent-ui/src/lib/library.ts`,
  including `components/*`, actions, functions and registered CSS. This profile
  uses the native `@openuidev/react-lang` library directly.
- OpenBitFun (`openbitfun`): `openbitfunComponents.tsx` adapts the OpenUI Lang
  contract to product controls. Chart, Map, Svg, HtmlView, Table and media remain
  GenUI-owned implementations in `oiComponents.tsx`, with explicit host event
  and inspection adapters.

Every registered component has a renderer and mounted inspector. Components
with an event also supply an isolated exercise adapter. Settings previews use
ordinary app descriptions and the production interpreter, with local disposable
state.
