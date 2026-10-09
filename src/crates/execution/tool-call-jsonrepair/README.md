# Tool-call JSON repair

This crate is a local fork of
[`jsonrepair-rs` 0.2.5](https://github.com/majiayu000/jsonrepair-rs), licensed
under MIT. The upstream license is retained in [`LICENSE`](LICENSE).

It retains the upstream generic repair API for compatibility, and adds
`repair_tool_call_json` for OpenBitFun streamed tool arguments. That profile does
not interpret `#`, `//`, or `/* ... */` as comments: tool arguments are JSON,
not configuration files. This prevents Markdown content whose opening quote
was omitted from being silently discarded as a comment.

The profile still supports bounded syntax recovery needed for malformed model
tool arguments, including missing string quotes, commas, and closing
delimiters. The caller must parse and schema-validate the result before use.

The fork keeps the upstream 0.2.5 parser fixes and regression coverage, while
retaining the separate comment-free tool-call profile. Schema-guided correction
from upstream 0.2.5 is intentionally not included; tool arguments are parsed
and validated by the owning tool pipeline.

## Upstream regression coverage

The non-CLI parser, streaming, and parity regression tests from
`jsonrepair-rs` 0.2.5 are vendored under `tests/`, with the local crate import
path adjusted. Schema-specific tests and the upstream CLI tests are omitted:
this internal library does not expose the schema helper, sets `autobins = false`,
and does not ship the upstream command-line program.
