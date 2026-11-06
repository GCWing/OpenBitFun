//! Slide deck edit operations.

use super::model::{DeckTheme, Element, ImageFit, PptxDocument, Slide};
use crate::common::{
    existing_span, insertion_index, move_span, parse_operation, report_extra, report_list,
    unknown_operation, DocumentProperties, Extra, UnknownFields,
};
use crate::docx::ops::patch_struct;
use crate::error::{OfficeError, OfficeResult};
use crate::image::sniff;
use crate::ApplyContext;
use serde::Deserialize;
use serde_json::{Map, Value};

pub(crate) const OPERATIONS: &[&str] = &[
    "insert_slides",
    "replace_slide",
    "update_slide",
    "delete_slides",
    "move_slides",
    "duplicate_slide",
    "set_theme",
    "set_properties",
];

const MAX_SLIDES: usize = 500;

#[derive(Deserialize)]
struct InsertSlides {
    #[serde(default)]
    index: Option<usize>,
    slides: Vec<Slide>,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct ReplaceSlide {
    index: usize,
    slide: Slide,
    #[serde(flatten)]
    extra: Extra,
}

#[derive(Deserialize)]
struct SlideSpan {
    index: usize,
    #[serde(default)]
    count: Option<usize>,
    #[serde(default)]
    to: Option<usize>,
    #[serde(flatten)]
    extra: Extra,
}

impl UnknownFields for InsertSlides {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        report_list(&self.slides, "slides", out);
    }
}

impl UnknownFields for ReplaceSlide {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        self.slide.unknown_fields("slide", out);
    }
}

impl UnknownFields for SlideSpan {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl UnknownFields for DeckTheme {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

pub(crate) fn apply(
    deck: &mut PptxDocument,
    op: &str,
    value: &Value,
    ctx: &mut ApplyContext,
) -> OfficeResult<()> {
    match op {
        "insert_slides" => {
            let input: InsertSlides = parse_operation(value)?;
            if input.slides.is_empty() {
                return Err(OfficeError::invalid(
                    "`slides` must contain at least one slide",
                ));
            }
            let at = insertion_index(input.index, deck.slides.len(), "slide")?;
            if deck.slides.len() + input.slides.len() > MAX_SLIDES {
                return Err(OfficeError::limit(format!(
                    "a deck is limited to {MAX_SLIDES} slides"
                )));
            }
            let mut slides = input.slides;
            for (offset, slide) in slides.iter_mut().enumerate() {
                prepare_slide(slide, deck, &format!("slides[{offset}]"), ctx)?;
            }
            let count = slides.len();
            shift_touched(ctx, at, count as i64);
            deck.slides.splice(at..at, slides);
            ctx.touched.extend(at..at + count);
            ctx.note(format!("inserted {count} slide(s) at index {at}"));
            Ok(())
        }
        "replace_slide" => {
            let input: ReplaceSlide = parse_operation(value)?;
            existing_span(input.index, None, deck.slides.len(), "slide")?;
            let mut slide = input.slide;
            prepare_slide(&mut slide, deck, "slide", ctx)?;
            deck.slides[input.index] = slide;
            ctx.touched.insert(input.index);
            ctx.note(format!("replaced slide {}", input.index));
            Ok(())
        }
        "update_slide" => update_slide(deck, value, ctx),
        "delete_slides" => {
            let input: SlideSpan = parse_operation(value)?;
            if input.to.is_some() {
                return Err(OfficeError::invalid("delete_slides does not take `to`"));
            }
            let span = existing_span(input.index, input.count, deck.slides.len(), "slide")?;
            let count = span.len();
            deck.slides.drain(span.clone());
            ctx.touched.retain(|index| !span.contains(index));
            shift_touched(ctx, span.end, -(count as i64));
            ctx.note(format!("deleted {count} slide(s) at index {}", input.index));
            Ok(())
        }
        "move_slides" => {
            let input: SlideSpan = parse_operation(value)?;
            let to = input
                .to
                .ok_or_else(|| OfficeError::invalid("move_slides needs `to`"))?;
            let span = existing_span(input.index, input.count, deck.slides.len(), "slide")?;
            move_span(&mut deck.slides, span.clone(), to, "slide")?;
            // Keep auditing edited/inserted slides after their positions change.
            // Moving a slide must not discard that batch's layout findings.
            ctx.touched = std::mem::take(&mut ctx.touched)
                .into_iter()
                .map(|index| {
                    if span.contains(&index) {
                        to + index - span.start
                    } else {
                        let after_removal = if index >= span.end {
                            index - span.len()
                        } else {
                            index
                        };
                        if after_removal >= to {
                            after_removal + span.len()
                        } else {
                            after_removal
                        }
                    }
                })
                .collect();
            ctx.note(format!("moved slide(s) from {} to {to}", input.index));
            Ok(())
        }
        "duplicate_slide" => {
            let input: SlideSpan = parse_operation(value)?;
            if input.count.is_some() {
                return Err(OfficeError::invalid(
                    "duplicate_slide copies one slide; it does not take `count`",
                ));
            }
            existing_span(input.index, None, deck.slides.len(), "slide")?;
            if deck.slides.len() >= MAX_SLIDES {
                return Err(OfficeError::limit(format!(
                    "a deck is limited to {MAX_SLIDES} slides"
                )));
            }
            let at = insertion_index(
                Some(input.to.unwrap_or(input.index + 1)),
                deck.slides.len(),
                "slide",
            )?;
            let copy = deck.slides[input.index].clone();
            shift_touched(ctx, at, 1);
            deck.slides.insert(at, copy);
            ctx.note(format!("duplicated slide {} to index {at}", input.index));
            Ok(())
        }
        "set_theme" => {
            patch_struct::<DeckTheme>(&mut deck.theme, value)?;
            deck.validate_settings()?;
            ctx.note("updated the deck theme".to_string());
            Ok(())
        }
        "set_properties" => {
            let input: DocumentProperties = parse_operation(value)?;
            deck.properties.merge(&input);
            ctx.note("updated document properties".to_string());
            Ok(())
        }
        other => Err(unknown_operation(other, OPERATIONS)),
    }
}

/// Keeps audit targets pointing at the same slides after a structural edit.
fn shift_touched(ctx: &mut ApplyContext, from: usize, delta: i64) {
    let shifted = std::mem::take(&mut ctx.touched)
        .into_iter()
        .map(|index| {
            if index >= from {
                (index as i64 + delta).max(0) as usize
            } else {
                index
            }
        })
        .collect();
    ctx.touched = shifted;
}

fn prepare_slide(
    slide: &mut Slide,
    deck: &PptxDocument,
    path: &str,
    ctx: &mut ApplyContext,
) -> OfficeResult<()> {
    slide.canonicalize();
    slide.validate(path)?;
    for (index, element) in slide.elements.iter_mut().enumerate() {
        prepare_element(element, deck, &format!("{path}.elements[{index}]"), ctx)?;
    }
    Ok(())
}

fn prepare_element(
    element: &mut Element,
    _deck: &PptxDocument,
    path: &str,
    ctx: &mut ApplyContext,
) -> OfficeResult<()> {
    if let Element::Image(image) = element {
        let asset = ctx.resolve_image(image.src.as_deref(), image.asset.as_deref(), path)?;
        image.asset = Some(asset.clone());
        if image.fit == ImageFit::Cover {
            if let Some(info) = ctx.assets.get(&asset).and_then(|bytes| sniff(bytes).ok()) {
                let picture = info.width as f64 / info.height as f64;
                let frame = image.w / image.h.max(1.0);
                let kept = (picture / frame).min(frame / picture);
                if kept < 0.5 {
                    ctx.warn(format!(
                        "{path}: the {:.0}×{:.0} box shows only {:.0}% of the {}×{} picture (center crop); size the box nearer the picture's aspect ratio or use fit=contain",
                        image.w,
                        image.h,
                        kept * 100.0,
                        info.width,
                        info.height
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Partial slide edit: slide fields, element patches by index, removals,
/// and appended elements, applied in that order.
fn update_slide(
    deck: &mut PptxDocument,
    value: &Value,
    ctx: &mut ApplyContext,
) -> OfficeResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| OfficeError::invalid("update_slide must be an object"))?;
    const KEYS: &[&str] = &[
        "op",
        "index",
        "title",
        "layout",
        "background",
        "notes",
        "elements",
        "update_elements",
        "remove_elements",
        "append_elements",
    ];
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) {
            return Err(OfficeError::invalid(format!(
                "unknown field `{key}`; update_slide accepts {}",
                KEYS[1..].join(", ")
            )));
        }
    }
    let index = object
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| OfficeError::invalid("update_slide needs a numeric `index`"))?
        as usize;
    existing_span(index, None, deck.slides.len(), "slide")?;
    if object.contains_key("elements")
        && ["update_elements", "remove_elements", "append_elements"]
            .iter()
            .any(|key| object.contains_key(*key))
    {
        return Err(OfficeError::invalid(
            "`elements` replaces the whole element list; do not combine it with update/remove/append_elements",
        ));
    }

    let mut slide = deck.slides[index].clone();
    let set_text =
        |target: &mut Option<String>, key: &str, object: &Map<String, Value>| -> OfficeResult<()> {
            match object.get(key) {
                None => Ok(()),
                Some(Value::Null) => {
                    *target = None;
                    Ok(())
                }
                Some(Value::String(text)) => {
                    *target = (!text.is_empty()).then(|| text.clone());
                    Ok(())
                }
                Some(_) => Err(OfficeError::invalid(format!(
                    "`{key}` must be a string or null"
                ))),
            }
        };
    set_text(&mut slide.title, "title", object)?;
    set_text(&mut slide.layout, "layout", object)?;
    set_text(&mut slide.background, "background", object)?;
    set_text(&mut slide.notes, "notes", object)?;

    if let Some(elements) = object.get("elements") {
        slide.elements = parse_elements(elements, "elements")?;
    }
    if let Some(patches) = object.get("update_elements") {
        let patches = patches.as_array().ok_or_else(|| {
            OfficeError::invalid("`update_elements` must be an array of {index, ...fields}")
        })?;
        for (patch_index, patch) in patches.iter().enumerate() {
            let path = format!("update_elements[{patch_index}]");
            let mut patch = patch
                .as_object()
                .cloned()
                .ok_or_else(|| OfficeError::invalid(format!("{path} must be an object")))?;
            let target = patch
                .remove("index")
                .and_then(|value| value.as_u64())
                .ok_or_else(|| OfficeError::invalid(format!("{path} needs a numeric `index`")))?
                as usize;
            if target >= slide.elements.len() {
                return Err(OfficeError::out_of_range(format!(
                    "{path}: element index {target} is out of range; the slide has {} element(s)",
                    slide.elements.len()
                )));
            }
            let mut current = serde_json::to_value(&slide.elements[target])
                .map_err(|err| OfficeError::invalid(err.to_string()))?;
            // Stored text is canonical paragraphs. A new plain-text value must
            // replace them, otherwise canonicalize() silently keeps the old text.
            if patch.get("text").is_some_and(Value::is_string) {
                if patch.contains_key("paragraphs") {
                    return Err(OfficeError::invalid(format!(
                        "{path}: pass text or paragraphs, not both"
                    )));
                }
                current
                    .as_object_mut()
                    .expect("serialized element object")
                    .remove("paragraphs");
            }
            crate::common::merge_patch(&mut current, &Value::Object(patch));
            let mut updated = parse_element(&current, &path)?;
            // A changed picture source must be embedded again.
            if let (Element::Image(new), Element::Image(old)) =
                (&mut updated, &slide.elements[target])
            {
                if new.src != old.src && new.asset == old.asset {
                    new.asset = None;
                }
            }
            slide.elements[target] = updated;
        }
    }
    if let Some(remove) = object.get("remove_elements") {
        let mut indexes: Vec<usize> = remove
            .as_array()
            .ok_or_else(|| {
                OfficeError::invalid("`remove_elements` must be an array of element indexes")
            })?
            .iter()
            .map(|value| value.as_u64().map(|index| index as usize))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                OfficeError::invalid("`remove_elements` must contain non-negative integers")
            })?;
        indexes.sort_unstable();
        indexes.dedup();
        if let Some(bad) = indexes.iter().find(|index| **index >= slide.elements.len()) {
            return Err(OfficeError::out_of_range(format!(
                "remove_elements: element index {bad} is out of range; the slide has {} element(s)",
                slide.elements.len()
            )));
        }
        for index in indexes.into_iter().rev() {
            slide.elements.remove(index);
        }
    }
    if let Some(append) = object.get("append_elements") {
        slide
            .elements
            .extend(parse_elements(append, "append_elements")?);
    }
    prepare_slide(&mut slide, deck, &format!("slides[{index}]"), ctx)?;
    deck.slides[index] = slide;
    ctx.touched.insert(index);
    ctx.note(format!("updated slide {index}"));
    Ok(())
}

fn parse_elements(value: &Value, path: &str) -> OfficeResult<Vec<Element>> {
    let items = value
        .as_array()
        .ok_or_else(|| OfficeError::invalid(format!("`{path}` must be an array of elements")))?;
    items
        .iter()
        .enumerate()
        .map(|(index, item)| parse_element(item, &format!("{path}[{index}]")))
        .collect()
}

fn parse_element(value: &Value, path: &str) -> OfficeResult<Element> {
    let element: Element = serde_json::from_value(value.clone())
        .map_err(|err| OfficeError::invalid(format!("{path}: {err}")))?;
    let mut unknown = Vec::new();
    element.unknown_fields(path, &mut unknown);
    if !unknown.is_empty() {
        return Err(OfficeError::invalid(format!(
            "unknown field(s): {}",
            unknown.join(", ")
        )));
    }
    Ok(element)
}
