# Product anatomy: current paint owners

These notes describe the target product, not a design template or an exhaustive
component catalog. Recheck the target checkout's descriptor, JSX, CSS and mounted
DOM. Importable fields are defined in [contract.md](contract.md). A CSS class or
product hook below does not create a slot with that name.

| Area | Existing owner/layer | Boundary that matters |
| --- | --- | --- |
| Shell and shared frame | `shell`; explicit `backgroundSource: "shell"` on selected surfaces | One image coordinate system; independent child readers can cover it |
| Expanded navigation | `navigation`, including history controls and shared corner base | Corner underlay follows the actual scene edge through resize/collapse |
| Collapsed navigation | Floating `nav-bar.root` delegates via `paint-layer=none` | Expanded-navigation material does not create a rectangle under the floating control |
| Window controls / Hi | Existing glyph/control paint and public launcher color tokens | Hit areas, positions and corner-tab geometry remain fixed |
| Button / IconButton | Advertised background layer, native element edge | Background and edge can have different owners; semantic variants remain product behavior |
| Closable TabGroup | `tab` paint/edge on advertised layers | The visible tab expands independently of its shorter label box |
| Default SearchField | Inner Input surface | Wrapper is not a second field material |
| Embedded or panel SearchField | Containing popup/panel; inner Input delegates | Inner delegated paint must not create a rectangular fill/focus shadow |
| Combobox / MultiSelect | `control` and separate popup `popover` | Control follows visible trigger radius, including pill variants; root also contains label/error |
| ActionCard | Rounded outer `root`; inner `trigger` | Arbitrary JSX attributes are forwarded to the inner button, not the rounded outer surface |
| Sidebar scenes | Structural Home/Agents/MiniApps/Assistants canvases and local cards/filters | Materialized workbench artwork can show through structure without clearing content or plugin documents |
| FlowChat message | `user-message-item.surface` | `content` is a distinct square content box |
| FlowChat input | `chat-composer.surface`, `contextBar` | Conversation canvas and input wrapper are separate owners |
| Markdown | `root`/`fallback`, `codeToolbar`, `codePre`, `tableHeadingCell`, `tableSurface` | Glyph, code and table material can be independent; heading foreground inherits its document root |
| Settings headings/actions | Transparent page/section headings and action containers | Buttons keep their own paint; the surrounding row is not a card |
| Settings groups | `config-page.sectionBody` on the actual FieldGroup | Primary identity is `field-group`; `config.sectionBody` is not a mounted target |
| Custom settings content | Existing sectionBody/local reading planes | Some explanatory paragraphs, lists and notices bypass standard section wrappers |
| Task calendar | Product-owned `.openbitfun-todos__calendar-body` reading plane, using the panel material | Weekdays and date grid share one plane; title/month actions stay transparent; plane extends into reserved gutter for edge/focus space |

The calendar body's class is not a new `todos.calendarBody` package slot. Its
current 12 CSS-px paint outset belongs to product CSS, not the skin schema.
A skin changes supported tokens/assets/parts; it cannot introduce padding or
repair missing/clipped product reading planes.

The product also owns `paint-layer`, `edge-layer` and
`data-openbitfun-reading-surface`. Skin authors cannot add, alter or imitate these
hooks. Delegation and nested-owner boundaries use the same resolver for CSS and
projection reports. If running anatomy contradicts the contract, report the
product/build mismatch rather than concealing it with unsupported package fields.

Recipe and diagnostic examples are in the optional
[authoring template](authoring-template.md). Visual acceptance, including corners,
focus rings and gutter clearance, is in [visual-review.md](visual-review.md).
