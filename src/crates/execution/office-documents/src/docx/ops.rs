//! Word edit operations.

use super::markdown::markdown_to_blocks;
use super::model::{Block, DocxDocument, DocxStyles, HeaderFooter, PageSetup};
use crate::common::{
    existing_span, insertion_index, merge_patch, move_span, parse_operation, report_extra,
    report_list, unknown_operation, Align, DocumentProperties, Extra, UnknownFields,
};
use crate::error::{OfficeError, OfficeResult};
use crate::ApplyContext;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const OPERATIONS: &[&str] = &[
    "insert_blocks",
    "replace_blocks",
    "delete_blocks",
    "move_blocks",
    "replace_text",
    "set_page_setup",
    "set_styles",
    "set_header_footer",
    "set_properties",
];

const MAX_BLOCKS: usize = 20_000;

#[derive(Deserialize)]
struct BlockContent {
    #[serde(default)]
    blocks: Option<Vec<Block>>,
    #[serde(default)]
    markdown: Option<String>,
}

#[derive(Deserialize)]
struct InsertBlocks {
    #[serde(default)]
    index: Option<usize>,
    #[serde(flatten)]
    content: BlockContent,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct ReplaceBlocks {
    index: usize,
    #[serde(default)]
    count: Option<usize>,
    #[serde(flatten)]
    content: BlockContent,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct DeleteBlocks {
    index: usize,
    #[serde(default)]
    count: Option<usize>,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct MoveBlocks {
    index: usize,
    #[serde(default)]
    count: Option<usize>,
    to: usize,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct ReplaceText {
    find: String,
    replace: String,
    #[serde(default = "default_true")]
    match_case: bool,
    #[serde(flatten)]
    extra: Extra,
}

fn default_true() -> bool {
    true
}

impl UnknownFields for BlockContent {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        if let Some(blocks) = &self.blocks {
            report_list(blocks, &format!("{path}blocks"), out);
        }
    }
}

impl UnknownFields for InsertBlocks {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_known_extra(&self.extra, &["blocks", "markdown"], path, out);
        self.content.unknown_fields(path, out);
    }
}

impl UnknownFields for ReplaceBlocks {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_known_extra(&self.extra, &["blocks", "markdown"], path, out);
        self.content.unknown_fields(path, out);
    }
}

impl UnknownFields for DeleteBlocks {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl UnknownFields for MoveBlocks {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl UnknownFields for ReplaceText {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

/// Two flattened structs see the same keys; drop the ones the sibling owns.
fn report_known_extra(extra: &Extra, owned_elsewhere: &[&str], path: &str, out: &mut Vec<String>) {
    let filtered: Extra = extra
        .iter()
        .filter(|(key, _)| !owned_elsewhere.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    report_extra(&filtered, path, out);
}

pub(crate) fn apply(
    doc: &mut DocxDocument,
    op: &str,
    value: &Value,
    ctx: &mut ApplyContext,
) -> OfficeResult<()> {
    match op {
        "insert_blocks" => {
            let input: InsertBlocks = parse_operation(value)?;
            let blocks = prepare_blocks(input.content, ctx)?;
            let at = insertion_index(input.index, doc.blocks.len(), "block")?;
            ensure_capacity(doc.blocks.len() + blocks.len())?;
            let count = blocks.len();
            doc.blocks.splice(at..at, blocks);
            ctx.note(format!("inserted {count} block(s) at index {at}"));
            Ok(())
        }
        "replace_blocks" => {
            let input: ReplaceBlocks = parse_operation(value)?;
            let span = existing_span(input.index, input.count, doc.blocks.len(), "block")?;
            let blocks = prepare_blocks(input.content, ctx)?;
            ensure_capacity(doc.blocks.len() - span.len() + blocks.len())?;
            let (removed, added) = (span.len(), blocks.len());
            doc.blocks.splice(span.clone(), blocks);
            ctx.note(format!(
                "replaced {removed} block(s) at index {} with {added}",
                span.start
            ));
            Ok(())
        }
        "delete_blocks" => {
            let input: DeleteBlocks = parse_operation(value)?;
            let span = existing_span(input.index, input.count, doc.blocks.len(), "block")?;
            let removed = span.len();
            doc.blocks.drain(span);
            ctx.note(format!(
                "deleted {removed} block(s) at index {}",
                input.index
            ));
            Ok(())
        }
        "move_blocks" => {
            let input: MoveBlocks = parse_operation(value)?;
            let span = existing_span(input.index, input.count, doc.blocks.len(), "block")?;
            move_span(&mut doc.blocks, span, input.to, "block")?;
            ctx.note(format!(
                "moved block(s) from {} to {}",
                input.index, input.to
            ));
            Ok(())
        }
        "replace_text" => {
            let input: ReplaceText = parse_operation(value)?;
            if input.find.is_empty() {
                return Err(OfficeError::invalid("`find` must not be empty"));
            }
            let mut replaced = 0;
            for block in &mut doc.blocks {
                for run in block.runs_mut() {
                    let (text, count) =
                        replace_all(&run.text, &input.find, &input.replace, input.match_case);
                    if count > 0 {
                        run.text = text;
                        replaced += count;
                    }
                }
            }
            if replaced == 0 {
                ctx.warn(format!(
                    "replace_text found no match for `{}` (a match split across differently formatted runs is not found)",
                    input.find
                ));
            } else {
                ctx.note(format!(
                    "replaced {replaced} occurrence(s) of `{}`",
                    input.find
                ));
            }
            Ok(())
        }
        "set_page_setup" => {
            patch_struct::<PageSetup>(&mut doc.page, value)?;
            doc.page.validate()?;
            ctx.note("updated page setup".to_string());
            Ok(())
        }
        "set_styles" => {
            patch_struct::<DocxStyles>(&mut doc.styles, value)?;
            doc.styles.validate()?;
            ctx.note("updated document styles".to_string());
            Ok(())
        }
        "set_header_footer" => {
            let object = value.as_object().cloned().unwrap_or_default();
            for key in object.keys() {
                if !matches!(key.as_str(), "op" | "header" | "footer") {
                    return Err(OfficeError::invalid(format!(
                        "unknown field `{key}`; set_header_footer accepts `header` and `footer`"
                    )));
                }
            }
            if let Some(header) = object.get("header") {
                doc.header = header_footer(header, "header")?;
            }
            if let Some(footer) = object.get("footer") {
                doc.footer = header_footer(footer, "footer")?;
            }
            ctx.note("updated header/footer".to_string());
            Ok(())
        }
        "set_properties" => {
            let input: DocumentProperties = parse_operation(value)?;
            doc.properties.merge(&input);
            ctx.note("updated document properties".to_string());
            Ok(())
        }
        other => Err(unknown_operation(other, OPERATIONS)),
    }
}

fn ensure_capacity(count: usize) -> OfficeResult<()> {
    if count > MAX_BLOCKS {
        return Err(OfficeError::limit(format!(
            "a document is limited to {MAX_BLOCKS} blocks"
        )));
    }
    Ok(())
}

fn header_footer(value: &Value, name: &str) -> OfficeResult<Option<HeaderFooter>> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) if text.trim().is_empty() => Ok(None),
        Value::String(text) => Ok(Some(HeaderFooter {
            text: text.clone(),
            align: Align::Center,
            extra: Extra::default(),
        })),
        Value::Object(_) => {
            let parsed: HeaderFooter = serde_json::from_value(value.clone())
                .map_err(|err| OfficeError::invalid(format!("{name}: {err}")))?;
            let mut unknown = Vec::new();
            parsed.unknown_fields(name, &mut unknown);
            if !unknown.is_empty() {
                return Err(OfficeError::invalid(format!(
                    "unknown field(s): {}",
                    unknown.join(", ")
                )));
            }
            Ok(Some(parsed))
        }
        _ => Err(OfficeError::invalid(format!(
            "{name} must be a string, an object {{text, align}}, or null"
        ))),
    }
}

/// Applies a JSON merge patch (the operation minus `op`) to a settings struct.
pub(crate) fn patch_struct<T>(target: &mut T, op_value: &Value) -> OfficeResult<()>
where
    T: Serialize + DeserializeOwned + UnknownFields,
{
    let mut patch = op_value.clone();
    if let Some(object) = patch.as_object_mut() {
        object.remove("op");
    }
    let mut current =
        serde_json::to_value(&*target).map_err(|err| OfficeError::invalid(err.to_string()))?;
    merge_patch(&mut current, &patch);
    let updated: T =
        serde_json::from_value(current).map_err(|err| OfficeError::invalid(err.to_string()))?;
    let mut unknown = Vec::new();
    updated.unknown_fields("", &mut unknown);
    if !unknown.is_empty() {
        return Err(OfficeError::invalid(format!(
            "unknown field(s): {}",
            unknown.join(", ")
        )));
    }
    *target = updated;
    Ok(())
}

fn prepare_blocks(content: BlockContent, ctx: &mut ApplyContext) -> OfficeResult<Vec<Block>> {
    let mut blocks = Vec::new();
    match (content.blocks, content.markdown) {
        (Some(_), Some(_)) => {
            return Err(OfficeError::invalid(
                "pass either `blocks` or `markdown`, not both",
            ))
        }
        (Some(list), None) => blocks.extend(list),
        (None, Some(markdown)) => {
            let parsed = markdown_to_blocks(&markdown);
            if parsed.is_empty() && !markdown.trim().is_empty() {
                ctx.warn("the markdown produced no blocks".to_string());
            }
            blocks.extend(parsed);
        }
        (None, None) => {
            return Err(OfficeError::invalid(
                "pass `blocks` (an array of block objects) or `markdown` (a string)",
            ))
        }
    }
    if blocks.is_empty() {
        return Err(OfficeError::invalid("no blocks to insert"));
    }
    for (index, block) in blocks.iter_mut().enumerate() {
        block.canonicalize();
        let path = format!("blocks[{index}]");
        block.validate(&path)?;
        if let Block::Image(image) = block {
            let asset = ctx.resolve_image(image.src.as_deref(), image.asset.as_deref(), &path)?;
            image.asset = Some(asset);
        }
    }
    Ok(blocks)
}

/// Replaces every occurrence, returning the new text and the match count.
pub(crate) fn replace_all(
    text: &str,
    find: &str,
    replace: &str,
    match_case: bool,
) -> (String, usize) {
    if match_case {
        let count = text.matches(find).count();
        return (text.replace(find, replace), count);
    }
    let lower_text = text.to_lowercase();
    let lower_find = find.to_lowercase();
    // Lowercasing can change byte lengths; fall back to exact matching then.
    if lower_text.len() != text.len() || lower_find.len() != find.len() {
        let count = text.matches(find).count();
        return (text.replace(find, replace), count);
    }
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    let mut cursor = 0;
    while let Some(position) = lower_text[cursor..].find(&lower_find) {
        let start = cursor + position;
        out.push_str(&text[cursor..start]);
        out.push_str(replace);
        cursor = start + find.len();
        count += 1;
    }
    out.push_str(&text[cursor..]);
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::replace_all;

    #[test]
    fn replaces_case_insensitively() {
        assert_eq!(
            replace_all("Foo foo", "foo", "bar", false),
            ("bar bar".to_string(), 2)
        );
        assert_eq!(
            replace_all("Foo foo", "foo", "bar", true),
            ("Foo bar".to_string(), 1)
        );
    }
}
