use super::{DocumentConversionError, DocumentPageSelection, DocumentPagination};

// Small enough that even a source paragraph without newlines fits the normal Read line cap.
// These are stable Unicode character chunks of extracted text, never Word/print page numbers.
pub const TEXT_CHUNK_CHARS: usize = 1600;

pub(super) fn select_text(
    markdown: String,
    selection: Option<&DocumentPageSelection>,
) -> Result<(String, DocumentPagination), DocumentConversionError> {
    let boundaries: Vec<usize> = markdown
        .char_indices()
        .step_by(TEXT_CHUNK_CHARS)
        .map(|(byte, _)| byte)
        .chain(std::iter::once(markdown.len()))
        .collect();
    let count = boundaries.len() - 1;
    let pagination = DocumentPagination::new("text_chunk", count, selection)?;
    let Some(selection) = selection else {
        return Ok((markdown, pagination));
    };
    let pages = selection
        .resolve(count)
        .map_err(|error| DocumentConversionError::new("invalidPages", error))?;
    let mut selected = String::new();
    for page in pages {
        if !selected.is_empty() {
            selected.push_str("\n\n");
        }
        selected.push_str(&format!("## Text chunk {page}\n\n"));
        selected.push_str(&markdown[boundaries[page as usize - 1]..boundaries[page as usize]]);
        if selected.len() > super::MAX_DOCUMENT_MARKDOWN_BYTES {
            return Err(DocumentConversionError::new(
                "resourceLimit",
                "selected text chunks exceed the Read output budget; request fewer pages",
            ));
        }
    }
    Ok((selected, pagination))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_cover_unicode_without_gaps_and_keep_legacy_full_text() {
        let source = "汉字🌏a".repeat(1201);
        let (legacy, metadata) = select_text(source.clone(), None).unwrap();
        assert_eq!(legacy, source);
        assert_eq!(metadata.page_count, 4);
        let selection = DocumentPageSelection::parse("2-3").unwrap();
        let (selected, metadata) = select_text(source.clone(), Some(&selection)).unwrap();
        assert_eq!(metadata.page_kind, "text_chunk");
        assert_eq!(metadata.next_page, Some(4));
        assert!(selected.contains("## Text chunk 2"));
        assert!(!selected.contains("## Text chunk 1"));
        let mut restored = String::new();
        for number in 1..=4 {
            let selection = DocumentPageSelection::parse(&number.to_string()).unwrap();
            let (chunk, _) = select_text(source.clone(), Some(&selection)).unwrap();
            restored.push_str(
                chunk
                    .strip_prefix(&format!("## Text chunk {number}\n\n"))
                    .unwrap(),
            );
        }
        assert_eq!(restored, source);
        assert_eq!(select_text(String::new(), None).unwrap().1.page_count, 0);
    }
}
