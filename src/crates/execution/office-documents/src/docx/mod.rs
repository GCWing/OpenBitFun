//! Word documents (`.docx`).

mod markdown;
mod math;
pub(crate) mod model;
pub(crate) mod ops;
pub(crate) mod render;

pub use markdown::{markdown_image_sources, markdown_to_blocks};
pub use model::{Block, DocxDocument};

use crate::common::preview;
use crate::{Detail, ReadRequest};
use serde_json::{json, Value};

pub(crate) fn read(doc: &DocxDocument, request: &ReadRequest) -> Value {
    let total = doc.blocks.len();
    let (offset, limit) = request.window(total, 50);
    let blocks: Vec<Value> = doc
        .blocks
        .iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(index, block)| {
            if request.detail == Detail::Full {
                let mut value = serde_json::to_value(block).unwrap_or(Value::Null);
                if let Some(object) = value.as_object_mut() {
                    object.insert("index".to_string(), json!(index));
                }
                return value;
            }
            let mut entry = json!({
                "index": index,
                "type": block.kind(),
            });
            let text = block.plain_text();
            if !text.is_empty() {
                entry["text"] = json!(preview(&text, 160));
            }
            match block {
                Block::Heading(heading) => entry["level"] = json!(heading.level),
                Block::List(list) => {
                    entry["items"] = json!(list.items.len());
                    entry["ordered"] = json!(list.ordered);
                }
                Block::Table(table) => {
                    entry["rows"] = json!(table.rows.len());
                    entry["columns"] = json!(table.rows.iter().map(Vec::len).max().unwrap_or(0));
                }
                Block::Image(image) => entry["asset"] = json!(image.asset),
                _ => {}
            }
            entry
        })
        .collect();
    let headings: Vec<Value> = doc
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| match block {
            Block::Heading(heading) => Some(json!({
                "index": index,
                "level": heading.level,
                "text": preview(&block.plain_text(), 80),
            })),
            _ => None,
        })
        .take(200)
        .collect();
    let mut view = json!({
        "total_blocks": total,
        "offset": offset,
        "limit": limit,
        "blocks": blocks,
        "headings": headings,
    });
    if offset + limit < total {
        view["next_offset"] = json!(offset + limit);
    }
    if offset == 0 {
        view["settings"] = json!({
            "properties": doc.properties,
            "page": doc.page,
            "styles": doc.styles,
            "header": doc.header,
            "footer": doc.footer,
        });
    }
    view
}
