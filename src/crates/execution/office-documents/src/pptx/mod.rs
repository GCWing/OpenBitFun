//! Slide decks (`.pptx`).

pub(crate) mod model;
pub(crate) mod ops;
pub(crate) mod render;

pub use model::{Element, PptxDocument, Slide, SHAPE_KINDS};

use crate::common::{preview, runs_text};
use crate::{Detail, ReadRequest};
use model::{Paragraph, TextDefaults};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(crate) fn read(deck: &PptxDocument, request: &ReadRequest) -> Value {
    let total = deck.slides.len();
    let default_limit = if request.detail == Detail::Full {
        5
    } else {
        30
    };
    let (offset, limit) = request.window(total, default_limit);
    let slides: Vec<Value> = deck
        .slides
        .iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(index, slide)| {
            if request.detail == Detail::Full {
                let mut value = serde_json::to_value(slide).unwrap_or(Value::Null);
                if let Some(elements) = value.get_mut("elements").and_then(Value::as_array_mut) {
                    for (element_index, element) in elements.iter_mut().enumerate() {
                        if let Some(object) = element.as_object_mut() {
                            object.insert("index".to_string(), json!(element_index));
                        }
                    }
                }
                if let Some(object) = value.as_object_mut() {
                    object.insert("index".to_string(), json!(index));
                }
                return value;
            }
            let text: Vec<String> = slide
                .elements
                .iter()
                .map(|element| element.plain_text())
                .filter(|text| !text.trim().is_empty())
                .collect();
            let mut kinds = std::collections::BTreeMap::<&str, usize>::new();
            for element in &slide.elements {
                *kinds.entry(element.kind()).or_default() += 1;
            }
            let mut entry = json!({
                "index": index,
                "label": preview(&slide.label(), 80),
                "elements": slide.elements.len(),
                "element_kinds": kinds,
                "text": preview(&text.join(" | "), 240),
            });
            if let Some(layout) = &slide.layout {
                entry["layout"] = json!(layout);
            }
            if let Some(background) = &slide.background {
                entry["background"] = json!(background);
            }
            if let Some(notes) = &slide.notes {
                entry["notes"] = json!(preview(notes, 120));
            }
            entry
        })
        .collect();
    let (width, height) = deck.slide_size.canvas();
    let mut view = json!({
        "total_slides": total,
        "offset": offset,
        "limit": limit,
        "canvas": { "width": width, "height": height, "unit": "px" },
        "slides": slides,
    });
    if offset + limit < total {
        view["next_offset"] = json!(offset + limit);
    }
    if offset == 0 {
        view["settings"] = json!({
            "properties": deck.properties,
            "slide_size": deck.slide_size,
            "theme": deck.theme,
        });
    }
    view
}

impl PptxDocument {
    /// Geometry findings: elements off the canvas and text that likely
    /// overflows its box. `only` limits the audit to some slides.
    pub fn audit(&self, only: Option<&BTreeSet<usize>>) -> Vec<String> {
        let (canvas_w, canvas_h) = self.slide_size.canvas();
        let mut findings = Vec::new();
        for (index, slide) in self.slides.iter().enumerate() {
            if only.is_some_and(|set| !set.contains(&index)) {
                continue;
            }
            if slide.elements.is_empty() {
                findings.push(format!("slide {index}: the slide has no elements"));
            }
            for (element_index, element) in slide.elements.iter().enumerate() {
                let (x, y, w, h) = element.bounds();
                let path = format!("slide {index} element {element_index} ({})", element.kind());
                if x < -1.0 || y < -1.0 || x + w > canvas_w + 1.0 || y + h > canvas_h + 1.0 {
                    findings.push(format!(
                        "{path}: box {x:.0},{y:.0} {w:.0}×{h:.0} extends past the {canvas_w:.0}×{canvas_h:.0} canvas"
                    ));
                }
                let (paragraphs, defaults, inset) = match element {
                    Element::Text(text) => (&text.paragraphs, &text.defaults, 0.0),
                    Element::Shape(shape) => (
                        &shape.paragraphs,
                        &shape.defaults,
                        shape.padding.unwrap_or(0.0),
                    ),
                    _ => continue,
                };
                let available_w = (w - inset * 2.0).max(1.0);
                let needed = estimate_text_height(paragraphs, defaults, available_w) + inset * 2.0;
                if needed > h * 1.08 + 4.0 {
                    findings.push(format!(
                        "{path}: text needs about {needed:.0}px of height but the box is {h:.0}px; enlarge h, shorten the text, or lower size_pt"
                    ));
                }
            }
        }
        findings.truncate(40);
        findings
    }
}

/// Rough text height in px using average glyph widths: CJK ≈ 1 em,
/// Latin ≈ 0.55 em, line height ≈ 1.2 em × line spacing.
pub(crate) fn estimate_text_height(
    paragraphs: &[Paragraph],
    defaults: &TextDefaults,
    width: f64,
) -> f64 {
    let mut height = 0.0;
    for paragraph in paragraphs {
        let size = paragraph
            .runs
            .iter()
            .filter_map(|run| run.size_pt)
            .fold(None, |max: Option<f64>, size| {
                Some(max.map_or(size, |current| current.max(size)))
            })
            .or(defaults.size_pt)
            .unwrap_or(18.0);
        let em = size * 96.0 / 72.0;
        let spacing = paragraph.line_spacing_pct.unwrap_or(100.0) / 100.0;
        let line_height = em * 1.2 * spacing;
        let indent = if paragraph.bullet || paragraph.numbered {
            em * 1.1 * (paragraph.level as f64 + 1.0)
        } else {
            0.0
        };
        let usable = (width - indent).max(em);
        let mut lines = 0.0;
        for line in runs_text(&paragraph.runs).split('\n') {
            let line_width: f64 = line
                .chars()
                .map(|c| {
                    if c == ' ' {
                        0.28
                    } else if is_wide(c) {
                        1.0
                    } else if c.is_ascii_uppercase() || c.is_ascii_digit() {
                        0.62
                    } else {
                        0.52
                    }
                })
                .sum::<f64>()
                * em;
            lines += (line_width / usable).ceil().max(1.0);
        }
        height += lines * line_height;
        height += (paragraph.space_before_pt.unwrap_or(0.0)
            + paragraph.space_after_pt.unwrap_or(0.0))
            * 96.0
            / 72.0;
    }
    height
}

fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 | 0x1F300..=0x1FAFF | 0x20000..=0x3FFFD)
}
