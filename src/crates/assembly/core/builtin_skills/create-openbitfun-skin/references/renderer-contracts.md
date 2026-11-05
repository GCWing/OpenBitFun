# Renderer contracts

List registered renderer adapters with:

```powershell
python scripts/openbitfun_appearance.py contract list renderers
```

Renderer entries use this shape:

```json
{
  "renderers": {
    "<renderer-id>": {
      "version": 1,
      "settings": {}
    }
  }
}
```

## theme-tokens

`settings.tokens` contains only canonical `--openbitfun-*` theme, component, and registered domain tokens. Optional
`settings.scopes` contains a registered scope such as `chrome`, whose values are limited to the scoped canonical
theme-token set. Query accepted root token names with:

```powershell
python scripts/openbitfun_appearance.py contract tokens theme
```

## monaco

Accepted settings: `id`, `base`, `inherit`, `rules`, and `colors`. IDs use lowercase letters, digits, and hyphens. Supported bases are `vs`, `vs-dark`, `hc-black`, and `hc-light`.

## xterm

Accepted settings: `surfaces`. It may define `terminal` and `output` color maps. Font family, size, weight, and line height remain owned by `@openbitfun/design-tokens` and cannot be overridden by an Appearance package.

## mermaid

Accepted settings: `mode` and `palette`. The validator reports unsupported or missing palette fields.

## generative-widget

Accepted settings: `id`, `mode`, and `vars`. Query accepted variable names with:

```powershell
python scripts/openbitfun_appearance.py contract tokens widget
```
