//! Select OOXML slides/sheets by their manifest order without reimplementing document rendering.
//! Only the in-memory manifest changes; relationships, styles, shared strings and assets survive.

use super::{DocumentConversionError, DocumentPageSelection};
use anydoc::Format;
use roxmltree::{Document, Node, ParsingOptions};
use std::io::{Cursor, Read, Write};
use std::ops::Range;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
const PRESENTATION_NS: [&str; 2] = [
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
];
const SHEET_NS: [&str; 2] = [
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
];

pub(super) struct OfficePageIndex {
    pub page_kind: &'static str,
    part: String,
    xml: String,
    units: Vec<(Range<usize>, Option<u32>)>,
}

impl OfficePageIndex {
    pub(super) fn read(
        bytes: &[u8],
        format: Format,
    ) -> Result<Option<Self>, DocumentConversionError> {
        if !matches!(format, Format::Pptx | Format::Excel) || !bytes.starts_with(b"PK") {
            return Ok(None);
        }
        let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(malformed)?;
        let mut part = None;
        if let Some(xml) = read_xml(&mut archive, "_rels/.rels")? {
            let doc = parse(&xml)?;
            for rel in doc
                .root_element()
                .children()
                .filter(|node| node.is_element())
            {
                if rel.tag_name().name() == "Relationship"
                    && rel.attribute("Type").is_some_and(|kind| matches!(kind,
                        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" |
                        "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"))
                    && rel.attribute("TargetMode") != Some("External")
                {
                    part = rel.attribute("Target").map(resolve_root_part).transpose()?;
                    break;
                }
            }
        }
        let part = part.unwrap_or_else(|| {
            if format == Format::Pptx {
                "ppt/presentation.xml"
            } else {
                "xl/workbook.xml"
            }
            .to_string()
        });
        // Binary Excel containers have no XML sheet manifest; advertise text chunks for them.
        if part.ends_with(".bin") || (format == Format::Excel && archive.by_name(&part).is_err()) {
            return Ok(None);
        }
        let xml =
            read_xml(&mut archive, &part)?.ok_or_else(|| malformed("missing Office manifest"))?;
        let doc = parse(&xml)?;
        let (namespaces, root_name, list_name, unit_name, page_kind) = if format == Format::Pptx {
            (
                &PRESENTATION_NS,
                "presentation",
                "sldIdLst",
                "sldId",
                "slide",
            )
        } else {
            (&SHEET_NS, "workbook", "sheets", "sheet", "sheet")
        };
        if !matches_element(doc.root_element(), namespaces, root_name) {
            return Err(malformed("unexpected Office manifest root"));
        }
        let mut count = 0;
        let units = doc
            .root_element()
            .children()
            .find(|node| matches_element(*node, namespaces, list_name))
            .into_iter()
            .flat_map(|list| list.children())
            .filter(|node| matches_element(*node, namespaces, unit_name))
            .map(|node| {
                let visible = page_kind != "sheet"
                    || !matches!(node.attribute("state"), Some("hidden" | "veryHidden"));
                let number = visible.then(|| {
                    count += 1;
                    count
                });
                (node.range(), number)
            })
            .collect();
        Ok(Some(Self {
            page_kind,
            part,
            xml,
            units,
        }))
    }

    pub(super) fn page_count(&self) -> usize {
        self.units.iter().filter(|(_, page)| page.is_some()).count()
    }

    pub(super) fn select(
        &self,
        bytes: &[u8],
        selection: &DocumentPageSelection,
    ) -> Result<Vec<u8>, DocumentConversionError> {
        let selected = selection
            .resolve(self.page_count())
            .map_err(|error| DocumentConversionError::new("invalidPages", error))?;
        let mut xml = String::with_capacity(self.xml.len());
        let mut cursor = 0;
        for (range, number) in &self.units {
            xml.push_str(&self.xml[cursor..range.start]);
            if number.is_some_and(|number| selected.binary_search(&number).is_ok()) {
                xml.push_str(&self.xml[range.clone()]);
            }
            cursor = range.end;
        }
        xml.push_str(&self.xml[cursor..]);

        let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(malformed)?;
        let mut output = ZipWriter::new(Cursor::new(Vec::with_capacity(bytes.len())));
        for index in 0..archive.len() {
            let file = archive.by_index_raw(index).map_err(malformed)?;
            if file.name() == self.part {
                output
                    .start_file(&self.part, SimpleFileOptions::default())
                    .map_err(malformed)?;
                output.write_all(xml.as_bytes()).map_err(malformed)?;
            } else {
                // Copy compressed bytes, never inflate unselected slides or embedded media.
                output.raw_copy_file(file).map_err(malformed)?;
            }
        }
        Ok(output.finish().map_err(malformed)?.into_inner())
    }
}

fn matches_element(node: Node<'_, '_>, namespaces: &[&str], name: &str) -> bool {
    node.is_element()
        && node.tag_name().name() == name
        && node
            .tag_name()
            .namespace()
            .is_some_and(|namespace| namespaces.contains(&namespace))
}

fn parse(xml: &str) -> Result<Document<'_>, DocumentConversionError> {
    Document::parse_with_options(
        xml,
        ParsingOptions {
            nodes_limit: 100_000,
            ..Default::default()
        },
    )
    .map_err(malformed)
}

fn read_xml(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    part: &str,
) -> Result<Option<String>, DocumentConversionError> {
    let mut file = match archive.by_name(part) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(malformed(error)),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(malformed)?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(DocumentConversionError::new(
            "resourceLimit",
            "Office page manifest exceeds the 2 MiB indexing limit",
        ));
    }
    let mut xml = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(b"<\0") {
        decode_utf16(bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(&bytes), true)?
    } else if bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(b"\0<") {
        decode_utf16(bytes.strip_prefix(&[0xfe, 0xff]).unwrap_or(&bytes), false)?
    } else {
        String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&bytes)
                .to_vec(),
        )
        .map_err(malformed)?
    };
    // We serialize UTF-8. Drop the original declaration, which may declare UTF-16.
    if xml.starts_with("<?xml ") {
        let end = xml
            .find("?>")
            .ok_or_else(|| malformed("unterminated XML declaration"))?;
        xml.drain(..end + 2);
    }
    Ok(Some(xml))
}

fn decode_utf16(bytes: &[u8], little: bool) -> Result<String, DocumentConversionError> {
    if bytes.len() % 2 != 0 {
        return Err(malformed("incomplete UTF-16 manifest"));
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16(&units).map_err(malformed)
}

/// OPC targets are URI/POSIX paths on every host OS; no filesystem access occurs here.
fn resolve_root_part(target: &str) -> Result<String, DocumentConversionError> {
    let mut decoded = Vec::new();
    let mut bytes = target.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let hi = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            let lo = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            match (hi, lo) {
                (Some(hi), Some(lo)) => (hi * 16 + lo) as u8,
                _ => return Err(malformed("invalid escaped Office part path")),
            }
        } else {
            byte
        });
    }
    let decoded = String::from_utf8(decoded).map_err(malformed)?;
    if decoded.contains([':', '\\', '\0', '?', '#']) {
        return Err(malformed("invalid Office part path"));
    }
    let mut parts = Vec::new();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(malformed("Office part escapes package"));
                }
            }
            _ => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

fn malformed(error: impl std::fmt::Display) -> DocumentConversionError {
    DocumentConversionError::new("malformed", format!("Office page index: {error}"))
}

#[cfg(test)]
mod tests {
    use super::super::convert_document_pages_to_markdown_sync as convert;
    use super::*;

    fn package(parts: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in parts {
            writer
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn root_rels(target: &str) -> Vec<u8> {
        format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{target}"/></Relationships>"#).into_bytes()
    }

    fn presentation() -> Vec<u8> {
        let manifest = br#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" r:id="second"/><p:sldId id="256" r:id="first"/></p:sldIdLst></p:presentation>"#;
        let rels = br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/one.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/two.xml"/></Relationships>"#;
        let slide = |text| {
            format!(r#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#).into_bytes()
        };
        package(vec![
            ("_rels/.rels", root_rels("custom/deck.xml")),
            ("custom/deck.xml", manifest.to_vec()),
            ("custom/_rels/deck.xml.rels", rels.to_vec()),
            ("custom/slides/one.xml", slide("Alpha slide")),
            ("custom/slides/two.xml", slide("Beta slide")),
            ("media/preserve.bin", vec![1, 2, 3, 4]),
        ])
    }

    #[test]
    fn presentation_selection_uses_manifest_order_and_isolated_cache_entries() {
        let bytes = presentation();
        let all = convert(&bytes, "test.pptx", None).unwrap();
        assert_eq!(all.pagination.page_kind, "slide");
        assert_eq!(all.pagination.page_count, 2);
        assert!(all.markdown.contains("Alpha slide") && all.markdown.contains("Beta slide"));
        let page1 = DocumentPageSelection::parse("1").unwrap();
        let first = convert(&bytes, "test.pptx", Some(&page1)).unwrap();
        assert!(first.markdown.contains("Beta slide"));
        assert!(!first.markdown.contains("Alpha slide"));
        let page2 = DocumentPageSelection::parse("2").unwrap();
        let second = convert(&bytes, "test.pptx", Some(&page2)).unwrap();
        assert!(second.markdown.contains("Alpha slide"));
        assert!(!second.markdown.contains("Beta slide"));
        assert_eq!(second.pagination.next_page, None);
        let repeated = convert(&bytes, "test.pptx", Some(&page1)).unwrap();
        assert_eq!(first.markdown, repeated.markdown);
        let selected = OfficePageIndex::read(&bytes, Format::Pptx)
            .unwrap()
            .unwrap()
            .select(&bytes, &page1)
            .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(selected)).unwrap();
        let mut asset = Vec::new();
        archive
            .by_name("media/preserve.bin")
            .unwrap()
            .read_to_end(&mut asset)
            .unwrap();
        assert_eq!(asset, vec![1, 2, 3, 4]);
        let invalid = DocumentPageSelection::parse("3").unwrap();
        assert_eq!(
            convert(&bytes, "test.pptx", Some(&invalid))
                .unwrap_err()
                .code(),
            "invalidPages"
        );
    }

    #[test]
    fn workbook_uses_visible_sheet_order_and_preserves_shared_strings_in_utf16_manifest() {
        let manifest = r#"<?xml version="1.0" encoding="UTF-16"?><workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"><sheets><sheet name="Private" sheetId="1" state="hidden" r:id="hidden"/><sheet name="Beta" sheetId="2" r:id="second"/><sheet name="Alpha" sheetId="3" r:id="first"/></sheets></workbook>"#;
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(manifest.encode_utf16().flat_map(u16::to_le_bytes));
        let rels = br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/one.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/two.xml"/><Relationship Id="hidden" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hidden.xml"/></Relationships>"#;
        let sheet = |index| {
            format!(r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>{index}</v></c></row></sheetData></worksheet>"#).into_bytes()
        };
        let bytes = package(vec![
            ("_rels/.rels", root_rels("xl/workbook.xml")),
            ("xl/workbook.xml", utf16),
            ("xl/_rels/workbook.xml.rels", rels.to_vec()),
            ("xl/worksheets/one.xml", sheet(0)),
            ("xl/worksheets/two.xml", sheet(1)),
            ("xl/worksheets/hidden.xml", sheet(2)),
            ("xl/sharedStrings.xml", br#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Alpha value</t></si><si><t>Beta value</t></si><si><t>Hidden value</t></si></sst>"#.to_vec()),
        ]);
        let all = convert(&bytes, "test.xlsx", None).unwrap();
        assert_eq!(all.pagination.page_kind, "sheet");
        assert_eq!(all.pagination.page_count, 2);
        assert!(!all.markdown.contains("Hidden value"));
        let selection = DocumentPageSelection::parse("2").unwrap();
        let selected = convert(&bytes, "test.xlsx", Some(&selection)).unwrap();
        assert!(
            selected.markdown.contains("Alpha value"),
            "{}",
            selected.markdown
        );
        assert!(!selected.markdown.contains("Beta value"));
        assert!(!selected.markdown.contains("Hidden value"));
    }

    #[test]
    fn word_chunks_expose_synthetic_units_and_can_read_beyond_a_long_paragraph() {
        let text = format!("{}End of long Word document", "A".repeat(4000));
        let xml = format!(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
        );
        let bytes = package(vec![("word/document.xml", xml.into_bytes())]);
        let all = convert(&bytes, "test.docx", None).unwrap();
        assert_eq!(all.pagination.page_kind, "text_chunk");
        assert_eq!(all.pagination.page_count, 3);
        let selection = DocumentPageSelection::parse("3").unwrap();
        let selected = convert(&bytes, "test.docx", Some(&selection)).unwrap();
        assert!(selected.markdown.contains("End of long Word document"));
        assert!(!selected.markdown.contains(&"A".repeat(1601)));
    }

    #[test]
    fn manifest_limits_and_package_paths_fail_explicitly() {
        assert_eq!(
            resolve_root_part("/folder/../deck%20name.xml").unwrap(),
            "deck name.xml"
        );
        for path in [
            "../outside.xml",
            "https://host/file",
            "a\\b",
            "bad%00.xml",
            "%xx",
        ] {
            assert!(resolve_root_part(path).is_err(), "{path}");
        }
        let bytes = package(vec![(
            "ppt/presentation.xml",
            vec![b' '; MAX_MANIFEST_BYTES + 1],
        )]);
        assert_eq!(
            OfficePageIndex::read(&bytes, Format::Pptx)
                .err()
                .unwrap()
                .code(),
            "resourceLimit"
        );
    }
}
