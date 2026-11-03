# GenUI library sources

The product compiles selected subsets into its declarative contract. The three
profiles share the OpenUI Lang parser/Renderer, but each profile owns its
library, adapter and style resources. No generated TSX, iframe, Tailwind
global reset or dynamic code loader is imported.

- Open Intelligent UI (`openui`): the upstream `open-intelligent-ui` library
  is vendored from `task_genui/open-intelligent-ui/src/lib/library.ts`,
  including `components/*`, actions, functions and the registered CSS. This
  profile uses the native `@openuidev/react-lang` library directly.

- OpenBitFun (`openbitfun`): `bitfunComponents.tsx` adapts the OpenUI Lang
  contract to the product's `@openbitfun/ui` Button, IconButton, Input,
  Textarea, Select, SegmentedControl, Checkbox, Radio and Card controls. Their
  mounted DOM and token styling come from the product library. Chart, Map, Svg,
  HtmlView, Table and media remain GenUI-owned implementations in
  `oiComponents.tsx`, with explicit host event and inspection adapters.
- Harmony reuses these product controls and adds its own renderers. The Harmony
  `Steps` renderer is
  sourced from `packages/react-ui/src/components/Steps/Steps.tsx` and is
  exposed through the BitFun adapter's contract, positional signature, DOM
  inspector, action bridge and token scope. `Metric` and `Table` remain
  BitFun-owned renderers for declarative presentation patterns. MIT attribution
  is retained in OPENUI-LICENSE.txt.
- Harmony GenUI: task_genui/harmony-genui, revision
  325488c1494b19c4867213f951eb336787f685f6. harmonyPlot.ts ports the pure
  whitelist expression parser and SVG/table renderer from
  packages/design-system/src/hm-plot.ts; sandbox mounting, generated scripts
  and global styles are excluded. MIT attribution is retained in
  HARMONY-LICENSE.txt. The host scopes styles and isolates SVG IDs per instance.
  The Harmony profile also carries the design-system's Apache-2.0 symbol
  metadata in hm-icons.ts and a product-owned stylesheet derived from the
  reference theme tokens. The stylesheet is intentionally limited to the
  trusted component/HTML renderer boundary and is not exposed as a generated
  global stylesheet. The unmodified HMSymbolVF.ttf file is bundled under
  src/web-ui/public/fonts/hm-symbol with Huawei's accompanying license notice.
Every registered component has a renderer and mounted inspector. Components with
an event also supply an isolated exercise adapter. Settings previews use ordinary
app descriptions and the production interpreter, with local disposable state.
