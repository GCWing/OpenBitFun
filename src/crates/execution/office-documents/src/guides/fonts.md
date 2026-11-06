## Text and font contract — all formats

Send ordinary Unicode strings. The engine writes UTF-8 XML and escapes markup;
do not transcode text, pre-escape XML/HTML, or replace non-Latin characters.
`lang` is a language hint, not an encoding or a guarantee of font coverage.

Leave font fields absent unless the user or a supplied template requires a
particular family. A professional appearance can use the defaults with deliberate
sizes, weights and spacing. Do not infer a font requirement from the generation
host's OS or copy an unverified font choice from a different document format.

When required, supply one family name recognized by the intended viewer: no CSS
fallback list, font-file path, surrounding quote characters, or guessed PostScript
name. Font names are preserved, not rewritten using a platform-specific alias
table. Fonts are not embedded, installed, or checked against a host font catalog.
The generating host and the viewer can be different machines. A locally installed
font or a successful preview in another app does not prove target-viewer support.

Omission preserves inheritance when creating content; patch omission preserves
the existing value. Follow each format's reset operation to remove an override.
In Word/PPT, an explicit local all-script `font` can override the document's East
Asian font. Use script-specific fields there when only one writing system should
change. Excel has a single font per cell; use its format-specific reset operation.

If displayed glyphs are wrong, first read the stored text. If Unicode is correct,
inspect and reset the relevant font overrides before selecting a verified family;
do not rewrite the text or change its encoding. `fonts_verified:false` means the
tool has not tested fonts in the intended viewer. Empty structural warnings do
not change that status. Report the actual verification scope when delivering.
