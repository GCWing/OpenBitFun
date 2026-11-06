//! End-to-end: build each format over several batches, reopen it, and check
//! that every XML part is well formed and carries the expected content.

use openbitfun_office_documents::{
    collect_image_sources, Detail, ImageSources, OfficeDocument, OfficeErrorKind, OfficeFormat,
    OpenOptions, ReadRequest,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

// A complete PNG keeps exported samples suitable for real Office viewers.
fn sample_png() -> Vec<u8> {
    include_bytes!("fixtures/chart.png").to_vec()
}

fn entries(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
    let mut out = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).expect("entry");
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).expect("read");
        out.insert(file.name().to_string(), buffer);
    }
    out
}

fn assert_well_formed(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let parts = entries(bytes);
    for (name, content) in &parts {
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let text = std::str::from_utf8(content).expect("utf8");
            roxmltree::Document::parse(text)
                .unwrap_or_else(|err| panic!("{name} is not well formed: {err}"));
        }
    }
    assert!(parts.contains_key("[Content_Types].xml"));
    assert!(parts.contains_key("openbitfun/genoffice.json"));
    parts
}

fn text_of(parts: &BTreeMap<String, Vec<u8>>, name: &str) -> String {
    String::from_utf8(
        parts
            .get(name)
            .unwrap_or_else(|| panic!("missing {name}"))
            .clone(),
    )
    .unwrap()
}

fn ops(value: Value) -> Vec<Value> {
    value.as_array().cloned().unwrap()
}

/// Writes samples for manual inspection when OFFICE_DOCUMENTS_SAMPLE_DIR is set.
fn keep_sample(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("OFFICE_DOCUMENTS_SAMPLE_DIR") {
        let path = std::path::Path::new(&dir).join(name);
        std::fs::File::create(path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
}

#[test]
fn docx_built_incrementally_and_reopened() {
    let mut doc = OfficeDocument::new(
        OfficeFormat::Docx,
        Some(&json!({"page": {"size": "a4", "margins_cm": {"left": 2.0, "right": 2.0}}, "styles": {"east_asia_font": "Microsoft YaHei"}})),
    )
    .unwrap();
    doc.touch("2026-11-05T10:00:00Z");
    let mut images = ImageSources::new();
    images.insert("/tmp/chart.png".to_string(), sample_png());
    let first = ops(json!([
        {"op": "set_properties", "title": "季度报告", "author": "Agent"},
        {"op": "insert_blocks", "markdown": "# 季度报告\n\n[TOC]\n\n## 概览\n\n收入增长 **23%**，详见 [官网](https://example.com)。\n\n- 第一点\n- 第二点\n  - 子项\n\n| 指标 | 数值 |\n|---|---:|\n| 收入 | 120 |\n\n![图表](/tmp/chart.png)"},
        {"op": "set_header_footer", "header": "内部资料", "footer": {"text": "第 {PAGE} 页 / 共 {NUMPAGES} 页", "align": "right"}}
    ]));
    assert_eq!(collect_image_sources(&first), vec!["/tmp/chart.png"]);
    let report = doc.apply(&first, &images).unwrap();
    assert_eq!(report.applied, 3);
    let bytes = doc.to_bytes().unwrap();
    keep_sample("sample.docx", &bytes);
    let parts = assert_well_formed(&bytes);
    let document = text_of(&parts, "word/document.xml");
    assert!(document.contains("季度报告"));
    assert!(document.contains("w:numId"));
    assert!(document.contains("TOC \\o"));
    assert!(document.contains("<w:tbl>"));
    assert!(parts.keys().any(|name| name.starts_with("word/media/img-")));
    assert!(text_of(&parts, "word/footer1.xml").contains("NUMPAGES"));

    // Second call: reopen without the original image file and keep editing.
    let mut reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let outline = reopened.read(&ReadRequest::default()).unwrap();
    let total = outline["total_blocks"].as_u64().unwrap() as usize;
    assert!(total >= 6);
    reopened
        .apply(
            &ops(json!([
                {"op": "insert_blocks", "blocks": [
                    {"type": "heading", "level": 2, "text": "风险"},
                    {"type": "paragraph", "runs": [{"text": "汇率波动", "bold": true}, {"text": " 可能影响利润。"}], "align": "justify"},
                    {"type": "page_break"},
                    {"type": "table", "rows": [["A", "B"], [1, {"text": "x", "fill": "#FFF2CC", "colspan": 1}]], "column_widths_cm": [4, 6]}
                ]},
                {"op": "replace_text", "find": "收入", "replace": "营收"},
                {"op": "move_blocks", "index": 0, "count": 1, "to": 1},
                {"op": "delete_blocks", "index": 1}
            ])),
            &ImageSources::new(),
        )
        .unwrap();
    let bytes = reopened.to_bytes().unwrap();
    let parts = assert_well_formed(&bytes);
    let document = text_of(&parts, "word/document.xml");
    assert!(document.contains("营收"));
    assert!(document.contains("汇率波动"));
    assert!(document.contains("w:type=\"page\""));
    // The picture embedded by the first call survived without its source file.
    assert!(parts.keys().any(|name| name.starts_with("word/media/img-")));

    let page = reopened
        .read(&ReadRequest {
            offset: Some(0),
            limit: Some(2),
            detail: Detail::Full,
            ..ReadRequest::default()
        })
        .unwrap();
    assert_eq!(page["blocks"].as_array().unwrap().len(), 2);
    assert!(page["next_offset"].is_number());
}

#[test]
fn docx_batches_are_atomic_and_report_the_failing_operation() {
    let mut doc = OfficeDocument::new(OfficeFormat::Docx, None).unwrap();
    doc.apply(
        &ops(json!([{"op": "insert_blocks", "markdown": "hello"}])),
        &ImageSources::new(),
    )
    .unwrap();
    let error = doc
        .apply(
            &ops(json!([
                {"op": "insert_blocks", "markdown": "second"},
                {"op": "delete_blocks", "index": 9}
            ])),
            &ImageSources::new(),
        )
        .unwrap_err();
    assert_eq!(error.kind, OfficeErrorKind::OutOfRange);
    assert_eq!(error.operation_index, Some(1));
    let view = doc.read(&ReadRequest::default()).unwrap();
    assert_eq!(
        view["total_blocks"],
        json!(1),
        "the failed batch must not leave partial edits"
    );

    let typo = doc
        .apply(&ops(json!([{"op": "insert_blocks", "blocks": [{"type": "paragraph", "text": "x", "colour": "#000"}]}])), &ImageSources::new())
        .unwrap_err();
    assert!(typo.message.contains("colour"), "{}", typo.message);
    let unknown = doc
        .apply(
            &ops(json!([{"op": "insert_block", "markdown": "x"}])),
            &ImageSources::new(),
        )
        .unwrap_err();
    assert!(
        unknown.message.contains("insert_blocks"),
        "{}",
        unknown.message
    );
}

#[test]
fn xlsx_rows_formulas_and_structure() {
    let mut book = OfficeDocument::new(OfficeFormat::Xlsx, None).unwrap();
    book.apply(
        &ops(json!([
            {"op": "add_sheet", "name": "Sales", "rows": [["Item", "Qty", "Price", "Total"], ["Apple", 2, 1.5, "=B2*C2"], ["Pear", 3, 2, "=B3*C3"]]},
            {"op": "append_rows", "sheet": "Sales", "rows": [["Sum", "=SUM(B2:B3)", null, "=SUM(D2:D3)"]]},
            {"op": "format_range", "sheet": "Sales", "range": "A1:D1", "style": {"bold": true, "fill_color": "#DDEBF7", "border": "thin"}},
            {"op": "format_range", "sheet": "Sales", "range": "C2:D4", "style": {"number_format": "#,##0.00"}},
            {"op": "set_column_widths", "sheet": "Sales", "widths": {"A": 16, "B:D": 12}},
            {"op": "freeze_panes", "sheet": "Sales", "rows": 1},
            {"op": "set_autofilter", "sheet": "Sales", "range": "A1:D3"},
            {"op": "add_sheet", "name": "Summary", "rows": [["Total", "=Sales!D4"], ["Date", {"value": "2024-03-31", "type": "date"}]]},
            {"op": "set_column_widths", "sheet": "Summary", "widths": {"A:B": 16}}
        ])),
        &ImageSources::new(),
    )
    .unwrap();
    // Inserting a row above the totals shifts every reference to it.
    book.apply(
        &ops(json!([
            {"op": "insert_rows", "sheet": "Sales", "row": 3, "rows": [["Fig", 1, 4, "=B3*C3"]]},
            {"op": "merge_cells", "sheet": "Sales", "range": "A6:D6"},
            {"op": "rename_sheet", "sheet": "Sales", "name": "Sales 2024"}
        ])),
        &ImageSources::new(),
    )
    .unwrap();
    let bytes = book.to_bytes().unwrap();
    keep_sample("sample.xlsx", &bytes);
    let parts = assert_well_formed(&bytes);
    let sheet1 = text_of(&parts, "xl/worksheets/sheet1.xml");
    assert!(sheet1.contains("<f>SUM(B2:B4)</f>"), "{sheet1}");
    assert!(
        sheet1.contains("<f>B4*C4</f>"),
        "the Pear row moved down: {sheet1}"
    );
    assert!(sheet1.contains("state=\"frozen\""));
    assert!(sheet1.contains("<autoFilter ref=\"A1:D4\"/>"));
    let sheet2 = text_of(&parts, "xl/worksheets/sheet2.xml");
    assert!(
        sheet2.contains("<f>&apos;Sales 2024&apos;!D5</f>"),
        "{sheet2}"
    );
    assert!(sheet2.contains("<v>45382</v>"), "date serial: {sheet2}");
    assert!(text_of(&parts, "xl/workbook.xml").contains("fullCalcOnLoad"));

    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let rows = reopened
        .read(&ReadRequest {
            sheet: Some("Sales 2024".to_string()),
            limit: Some(2),
            ..ReadRequest::default()
        })
        .unwrap();
    assert_eq!(rows["rows"].as_array().unwrap().len(), 2);
    assert_eq!(rows["next_offset"], json!(2));
    assert_eq!(
        rows["rows"][1]["cells"][3],
        json!({"formula": "=B2*C2", "value": 3.0})
    );
}

#[test]
fn pptx_slides_with_notes_tables_and_images() {
    let mut deck = OfficeDocument::new(
        OfficeFormat::Pptx,
        Some(&json!({"theme": {"font": "Arial", "east_asia_font": "Microsoft YaHei"}})),
    )
    .unwrap();
    let mut images = ImageSources::new();
    images.insert("/tmp/hero.png".to_string(), sample_png());
    deck.apply(
        &ops(json!([
            {"op": "insert_slides", "slides": [
                {"title": "Cover", "background": "#0E1A2B", "notes": "Open with the 40% figure.", "elements": [
                    {"type": "shape", "shape": "rect", "x": 0, "y": 0, "w": 520, "h": 720, "fill": "#1F3A5F"},
                    {"type": "text", "x": 80, "y": 220, "w": 760, "h": 120, "text": "The 40% squeeze", "sizePt": 48, "bold": true, "color": "#FFFFFF"},
                    {"type": "image", "url": "/tmp/hero.png", "x": 660, "y": 80, "w": 540, "h": 560}
                ]},
                {"title": "Data", "elements": [
                    {"type": "text", "x": 80, "y": 40, "w": 1120, "h": 70, "paragraphs": [{"runs": [{"text": "Where the margin went", "sizePt": 32, "bold": true}]}]},
                    {"type": "table", "x": 80, "y": 140, "w": 1120, "h": 240, "rows": [["Cost", "Change"], ["Fuel", "+31%"], ["Wages", "+18%"]]},
                    {"type": "shape", "shape": "lineArrow", "x": 80, "y": 420, "w": 400, "h": 0, "stroke": {"color": "#C00000", "widthPt": 2}},
                    {"type": "text", "x": 80, "y": 460, "w": 300, "h": 30, "paragraphs": [{"text": "A long bullet that will not fit in this tiny box at all because it keeps going", "bullet": true}]}
                ]}
            ]}
        ])),
        &images,
    )
    .map(|report| {
        assert!(report.warnings.iter().any(|warning| warning.contains("text needs about")), "{:?}", report.warnings);
    })
    .unwrap();
    let bytes = deck.to_bytes().unwrap();
    keep_sample("sample.pptx", &bytes);
    let parts = assert_well_formed(&bytes);
    let slide1 = text_of(&parts, "ppt/slides/slide1.xml");
    assert!(slide1.contains("The 40% squeeze"));
    assert!(slide1.contains("<a:srcRect"), "cover crop expected");
    assert!(parts.contains_key("ppt/notesSlides/notesSlide1.xml"));
    assert!(parts.contains_key("ppt/notesMasters/notesMaster1.xml"));
    assert!(text_of(&parts, "ppt/slides/slide2.xml").contains("<a:tbl>"));

    let mut reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let full = reopened
        .read(&ReadRequest {
            offset: Some(0),
            limit: Some(1),
            detail: Detail::Full,
            ..ReadRequest::default()
        })
        .unwrap();
    let image = &full["slides"][0]["elements"][2];
    assert!(image["asset"].as_str().unwrap().starts_with("img-"));
    reopened
        .apply(
            &ops(json!([
                {"op": "update_slide", "index": 0, "update_elements": [{"index": 1, "color": "#FFD966"}], "remove_elements": [0]},
                {"op": "duplicate_slide", "index": 1},
                {"op": "move_slides", "index": 2, "to": 0},
                {"op": "delete_slides", "index": 2}
            ])),
            &ImageSources::new(),
        )
        .unwrap();
    let view = reopened.read(&ReadRequest::default()).unwrap();
    assert_eq!(view["total_slides"], json!(2));
    assert_eq!(view["slides"][0]["label"], json!("Data"));
    assert_eq!(view["slides"][1]["label"], json!("Cover"));
    let parts = assert_well_formed(&reopened.to_bytes().unwrap());
    assert!(text_of(&parts, "ppt/slides/slide2.xml").contains("FFD966"));
}

#[test]
fn xlsx_range_reads_are_paged_and_full_text_is_lossless() {
    let mut book = OfficeDocument::new(OfficeFormat::Xlsx, None).unwrap();
    let long_text = "long cell text ".repeat(40);
    let rows: Vec<Value> = (0..600).map(|_| json!([long_text])).collect();
    book.apply(
        &[json!({"op": "add_sheet", "name": "Data", "rows": rows})],
        &ImageSources::new(),
    )
    .unwrap();
    let request = ReadRequest {
        sheet: Some("Data".to_string()),
        range: Some("A1:A600".to_string()),
        detail: Detail::Full,
        limit: Some(2),
        ..ReadRequest::default()
    };
    let page = book.read(&request).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    assert_eq!(page["rows"][0]["cells"][0], json!(long_text));
    assert_eq!(page["next_offset"], json!(2));
    let last = book
        .read(&ReadRequest {
            offset: Some(599),
            ..request
        })
        .unwrap();
    assert_eq!(last["rows"].as_array().unwrap().len(), 1);
    assert_eq!(last["rows"][0]["row"], json!(600));
    assert!(last.get("next_offset").is_none());
}

#[test]
fn xlsx_insert_rows_cannot_overwrite_existing_rows() {
    let mut book = OfficeDocument::new(OfficeFormat::Xlsx, None).unwrap();
    book.apply(
        &[json!({"op": "add_sheet", "name": "Data", "rows": [["keep"]]})],
        &ImageSources::new(),
    )
    .unwrap();
    let before = book.to_bytes().unwrap();
    assert!(book
        .apply(
            &[json!({"op": "insert_rows", "row": 1, "count": 1, "rows": [["new"], ["overwrite"]]})],
            &ImageSources::new()
        )
        .is_err());
    assert_eq!(book.to_bytes().unwrap(), before);
}

#[test]
fn external_changes_are_detected() {
    let mut doc = OfficeDocument::new(OfficeFormat::Docx, None).unwrap();
    doc.apply(
        &ops(json!([{"op": "insert_blocks", "markdown": "hello"}])),
        &ImageSources::new(),
    )
    .unwrap();
    let bytes = doc.to_bytes().unwrap();
    let mut parts = entries(&bytes);
    let document = text_of(&parts, "word/document.xml").replace("hello", "edited elsewhere");
    parts.insert("word/document.xml".to_string(), document.into_bytes());
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in &parts {
        writer
            .start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(content).unwrap();
    }
    let modified = writer.finish().unwrap().into_inner();
    let error = OfficeDocument::open(&modified, &OpenOptions::default()).unwrap_err();
    assert_eq!(error.kind, OfficeErrorKind::ExternallyModified);
    assert!(OfficeDocument::open(
        &modified,
        &OpenOptions {
            discard_external_changes: true
        }
    )
    .is_ok());

    let foreign = {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"<w:document/>").unwrap();
        writer.finish().unwrap().into_inner()
    };
    assert_eq!(
        OfficeDocument::open(&foreign, &OpenOptions::default())
            .unwrap_err()
            .kind,
        OfficeErrorKind::NotGenerated
    );
}

#[test]
fn unknown_fields_in_stored_documents_survive_a_round_trip() {
    let mut deck = OfficeDocument::new(OfficeFormat::Pptx, None).unwrap();
    deck.apply(
        &ops(json!([{"op": "insert_slides", "slides": [{"elements": [{"type": "text", "x": 10, "y": 10, "w": 200, "h": 40, "text": "hi"}]}]}])),
        &ImageSources::new(),
    )
    .unwrap();
    let bytes = deck.to_bytes().unwrap();
    // Simulate a newer writer that stored a field this version does not know.
    let mut parts = entries(&bytes);
    let mut source: Value = serde_json::from_slice(&parts["openbitfun/genoffice.json"]).unwrap();
    source["document"]["slides"][0]["future_field"] = json!({"kept": true});
    parts.insert(
        "openbitfun/genoffice.json".to_string(),
        serde_json::to_vec(&source).unwrap(),
    );
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in &parts {
        writer
            .start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(content).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let parts = entries(&reopened.to_bytes().unwrap());
    let source: Value = serde_json::from_slice(&parts["openbitfun/genoffice.json"]).unwrap();
    assert_eq!(
        source["document"]["slides"][0]["future_field"],
        json!({"kept": true})
    );
}

#[test]
fn image_sources_include_markdown_and_element_patches() {
    let operations = ops(json!([
        {"op": "insert_blocks", "markdown": "![a](/abs/a.png)", "blocks": null},
        {"op": "insert_slides", "slides": [{"elements": [
            {"type": "image", "src": "/abs/b.png", "x": 0, "y": 0, "w": 10, "h": 10},
            {"type": "image", "asset": "img-00.png", "src": "/abs/gone.png", "x": 0, "y": 0, "w": 10, "h": 10},
            {"type": "text", "x": 0, "y": 0, "w": 10, "h": 10, "paragraphs": [{"runs": [{"text": "x", "url": "https://example.com"}]}]}
        ]}]},
        {"op": "update_slide", "index": 0, "update_elements": [{"index": 0, "src": "/abs/c.png"}]},
        {"op": "insert_slides", "slides": [{"elements": [{"type": "image", "src": "data:image/png;base64,AAAA", "x": 0, "y": 0, "w": 1, "h": 1}]}]}
    ]));
    assert_eq!(
        collect_image_sources(&operations),
        vec!["/abs/a.png", "/abs/b.png", "/abs/c.png"]
    );
}

#[test]
fn pptx_failed_replacement_recovers_in_place_without_losing_text_or_audit() {
    let images = ImageSources::new();
    let mut deck = OfficeDocument::new(OfficeFormat::Pptx, None).unwrap();
    let slide = |title: &str| {
        json!({"title": title, "notes": "Keep these notes", "elements": [
            {"type":"text","x":40,"y":40,"w":800,"h":90,"size_pt":30,"text":title},
            {"type":"shape","shape":"rect","x":40,"y":160,"w":800,"h":90,"fill":"#EFEFEF","text":"Original card"}
        ]})
    };
    deck.apply(&[json!({"op":"insert_slides","slides":(0..9).map(|i|slide(&format!("Page {i}"))).collect::<Vec<_>>()})], &images).unwrap();
    let saved = deck.to_bytes().unwrap();
    // Same operation order/source index as the reported model call.
    let error = deck
        .apply(
            &ops(json!([
                {"op":"insert_slides","slides":[slide("Replacement")]},
                {"op":"delete_slides","index":4},
                {"op":"move_slides","index":9,"to":4}
            ])),
            &images,
        )
        .unwrap_err();
    assert_eq!(error.operation_index, Some(2));
    assert_eq!(error.kind, OfficeErrorKind::OutOfRange);
    assert_eq!(deck.to_bytes().unwrap(), saved);

    let mut deck = OfficeDocument::open(&saved, &OpenOptions::default()).unwrap();
    deck.apply(
        &ops(json!([
            {"op":"replace_slide","index":4,"slide":slide("Replaced")},
            {"op":"update_slide","index":4,"update_elements":[
                {"index":0,"text":"四种模式，按任务选择协作方式"},
                {"index":1,"text":"已更新卡片\nSecond line"}
            ]}
        ])),
        &images,
    )
    .unwrap();
    let parts = assert_well_formed(&deck.to_bytes().unwrap());
    let xml = text_of(&parts, "ppt/slides/slide5.xml");
    assert!(xml.contains("四种模式，按任务选择协作方式"));
    assert!(xml.contains("已更新卡片"));
    assert!(xml.contains("Second line"));
    assert!(!xml.contains("Original card"));
    assert!(!xml.contains("Replaced"));
    let view = deck
        .read(&ReadRequest {
            offset: Some(4),
            limit: Some(1),
            detail: Detail::Full,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(view["total_slides"], 9);
    assert_eq!(view["slides"][0]["notes"], "Keep these notes");
    assert_eq!(view["slides"][0]["elements"][0]["size_pt"], 30.0);

    // Geometry findings must follow a newly inserted slide through delete/move.
    let report = deck.apply(&ops(json!([
        {"op":"insert_slides","slides":[{"elements":[{"type":"text","x":1400,"y":40,"w":100,"h":90,"text":"Outside"}]}]},
        {"op":"delete_slides","index":4},
        {"op":"move_slides","index":8,"to":4}
    ])), &images).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("slide 4 element 0") && w.contains("extends past")),
        "{:?}",
        report.warnings
    );
    // And follow an edited existing slide when a preceding block moves past it.
    let report = deck
        .apply(
            &ops(json!([
                {"op":"update_slide","index":4,"update_elements":[{"index":0,"x":1500}]},
                {"op":"move_slides","index":0,"count":2,"to":7}
            ])),
            &images,
        )
        .unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("slide 2 element 0") && w.contains("extends past")),
        "{:?}",
        report.warnings
    );
}

#[test]
fn pptx_cjk_language_and_fonts_survive_export_reopen_and_edits() {
    let mut deck = OfficeDocument::new(
        OfficeFormat::Pptx,
        Some(&json!({"theme":{"font":"Arial","east_asia_font":"PingFang SC"}})),
    )
    .unwrap();
    let cases = [
        ("四种模式 & <Agent> 🙂", None, "zh-CN"),
        ("日本語の説明", None, "ja-JP"),
        ("한국어 설명", None, "ko-KR"),
        ("Plain English", None, "en-US"),
        ("繁體中文", Some("zh-TW"), "zh-TW"),
        ("日本漢字", Some("ja-JP"), "ja-JP"),
    ];
    let elements: Vec<_> = cases
        .iter()
        .enumerate()
        .map(|(i, (text, lang, _))| {
            let mut element =
                json!({"type":"text","x":40,"y":40+i*90,"w":1100,"h":80,"size_pt":28,"text":text});
            if let Some(lang) = lang {
                element["lang"] = json!(lang);
            }
            element
        })
        .collect();
    deck.apply(
        &[json!({"op":"insert_slides","slides":[{"notes":"中文演讲备注","elements":elements}]})],
        &ImageSources::new(),
    )
    .unwrap();
    let bytes = deck.to_bytes().unwrap();
    keep_sample("cjk-languages.pptx", &bytes);
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let parts = assert_well_formed(&reopened.to_bytes().unwrap());
    let xml = text_of(&parts, "ppt/slides/slide1.xml");
    let dom = roxmltree::Document::parse(&xml).unwrap();
    for (text, _, lang) in cases {
        let t = dom
            .descendants()
            .find(|node| {
                node.has_tag_name(("http://schemas.openxmlformats.org/drawingml/2006/main", "t"))
                    && node.text() == Some(text)
            })
            .unwrap();
        let properties = t
            .parent()
            .unwrap()
            .children()
            .find(|n| n.tag_name().name() == "rPr")
            .unwrap();
        assert_eq!(properties.attribute("lang"), Some(lang));
        // Preserve theme/script fallback; do not force a platform UI font onto
        // every run just because it was supplied as a generic theme font.
        assert!(!properties.children().any(|n| n.tag_name().name() == "ea"));
        let end = t
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .children()
            .find(|n| n.tag_name().name() == "endParaRPr")
            .unwrap();
        assert_eq!(end.attribute("lang"), Some(lang));
    }
    let theme_xml = text_of(&parts, "ppt/theme/theme1.xml");
    let theme = roxmltree::Document::parse(&theme_xml).unwrap();
    for (script, expected) in [
        ("Hans", "等线"),
        ("Hant", "新細明體"),
        ("Jpan", "游ゴシック"),
        ("Hang", "맑은 고딕"),
    ] {
        let font = theme
            .descendants()
            .find(|n| n.attribute("script") == Some(script))
            .unwrap();
        assert_eq!(font.attribute("typeface"), Some(expected));
    }
    assert!(text_of(&parts, "ppt/notesSlides/notesSlide1.xml").contains("lang=\"zh-CN\""));

    // Theme, element, paragraph and run language overrides retain precedence.
    let mut edited = reopened;
    edited.apply(&ops(json!([
        {"op":"set_theme","lang":"zh-TW"},
        {"op":"replace_slide","index":0,"slide":{"elements":[
            {"type":"text","x":40,"y":40,"w":1000,"h":80,"text":"主題語言"},
            {"type":"text","x":40,"y":140,"w":1000,"h":80,"lang":"zh-CN","paragraphs":[{"lang":"ja-JP","runs":[{"text":"漢字"},{"text":"繁體","lang":"zh-HK"}]}]},
            {"type":"table","x":40,"y":240,"w":600,"h":200,"rows":[[{"runs":[{"text":"한국어","lang":"ko-KR"}]}]]}
        ]}}
    ])), &ImageSources::new()).unwrap();
    let bytes = edited.to_bytes().unwrap();
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let parts = entries(&reopened.to_bytes().unwrap());
    let xml = text_of(&parts, "ppt/slides/slide1.xml");
    let dom = roxmltree::Document::parse(&xml).unwrap();
    for (text, lang) in [
        ("主題語言", "zh-TW"),
        ("漢字", "ja-JP"),
        ("繁體", "zh-HK"),
        ("한국어", "ko-KR"),
    ] {
        let t = dom
            .descendants()
            .find(|n| n.tag_name().name() == "t" && n.text() == Some(text))
            .unwrap();
        assert_eq!(
            t.parent()
                .unwrap()
                .children()
                .find(|n| n.tag_name().name() == "rPr")
                .unwrap()
                .attribute("lang"),
            Some(lang)
        );
    }
}

#[test]
fn legacy_pptx_without_language_fields_round_trips_and_renders_cjk() {
    // Hand-authored version-1 payload: no new language fields, no current writer.
    let legacy = br#"{"schema":"openbitfun.genoffice","version":1,"format":"pptx","revision":7,"document":{"slide_size":"16:9","theme":{"font":"Arial"},"slides":[{"title":"Legacy","elements":[{"type":"text","x":40,"y":40,"w":900,"h":90,"paragraphs":[{"runs":[{"text":"\u4e2d\u6587 Agent"}]}]}]}]}}"#;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(
        "openbitfun/genoffice.json",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(legacy).unwrap();
    let old_bytes = zip.finish().unwrap().into_inner();
    let old = OfficeDocument::open(&old_bytes, &OpenOptions::default()).unwrap();
    assert_eq!(old.revision(), 7);
    let read = ReadRequest {
        detail: Detail::Full,
        ..Default::default()
    };
    let old_view = old.read(&read).unwrap();
    let bytes = old.to_bytes().unwrap();
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    assert_eq!(reopened.read(&read).unwrap(), old_view);
    let parts = assert_well_formed(&bytes);
    assert!(text_of(&parts, "ppt/slides/slide1.xml").contains("lang=\"zh-CN\""));
    let source: Value = serde_json::from_slice(&parts["openbitfun/genoffice.json"]).unwrap();
    assert_eq!(source["version"], 1);
    assert!(source["document"]["theme"].get("lang").is_none());
    assert!(
        source["document"]["slides"][0]["elements"][0]["paragraphs"][0]["runs"][0]
            .get("lang")
            .is_none()
    );
}

#[test]
fn unicode_text_is_preserved_in_word_and_excel_xml() {
    let text = "中文、繁體、日本語、한국어 & <Agent> 🙂";
    for (format, operations, part) in [
        (
            OfficeFormat::Docx,
            vec![
                json!({"op":"insert_blocks","blocks":[{"type":"paragraph","runs":[{"text":text,"lang":"zh-CN"}]}]}),
            ],
            "word/document.xml",
        ),
        (
            OfficeFormat::Xlsx,
            vec![json!({"op":"add_sheet","name":"数据","rows":[[text]]})],
            "xl/sharedStrings.xml",
        ),
    ] {
        let mut doc = OfficeDocument::new(format, None).unwrap();
        doc.apply(&operations, &ImageSources::new()).unwrap();
        let bytes = doc.to_bytes().unwrap();
        let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
        let parts = assert_well_formed(&reopened.to_bytes().unwrap());
        let xml = text_of(&parts, part);
        let dom = roxmltree::Document::parse(&xml).unwrap();
        assert!(
            dom.descendants()
                .any(|n| n.tag_name().name() == "t" && n.text() == Some(text)),
            "{xml}"
        );
        if format == OfficeFormat::Docx {
            assert!(xml.contains("w:lang w:val=\"zh-CN\""));
        }
    }
}

#[test]
fn xlsx_native_charts_follow_data_edits_and_keep_editable_references() {
    let mut book = OfficeDocument::new(OfficeFormat::Xlsx, None).unwrap();
    let images = ImageSources::new();
    book.apply(&ops(json!([
        {"op":"add_sheet","name":"数据'明细","rows":[["项目","数量","营收"],["中文",10,"=B2*2"],["日本語",20,"=B3*2"],["한국어",30,"=B4*2"]]},
        {"op":"add_sheet","name":"Charts 图表"}
    ])), &images).unwrap();
    for (kind, anchor, title) in [
        ("column", "A1", "季度营收 · Column"),
        ("bar", "K1", "条形图 · Bar"),
        ("line", "A22", "趋势 · Line"),
        ("pie", "K22", "占比 · Pie"),
    ] {
        book.apply(&[json!({"op":"add_chart","sheet":"Charts 图表","chart":{
            "type":kind,"title":title,"anchor":anchor,"width_px":560,"height_px":310,
            "series":[{"name":"营收","categories":{"sheet":"数据'明细","range":"A2:A4"},"values":{"sheet":"数据'明细","range":"C2:C4"}}]
        }})], &images).unwrap();
    }
    let bytes = book.to_bytes().unwrap();
    keep_sample("native-charts.xlsx", &bytes);
    let parts = assert_well_formed(&bytes);
    for index in 1..=4 {
        let chart = text_of(&parts, &format!("xl/charts/chart2_{index}.xml"));
        assert!(chart.contains("<c:numRef>"));
        assert!(chart.contains("&apos;数据&apos;&apos;明细&apos;!$C$2:$C$4"));
        assert!(chart.contains("<c:v>60</c:v>"));
        assert!(chart.contains("<c:v>日本語</c:v>"));
        if index < 4 {
            // Excel treats an omitted axis delete flag as hidden even though
            // it still reads the series. Keep both axes explicitly visible.
            assert_eq!(chart.matches("<c:delete val=\"0\"/>").count(), 2);
        }
    }
    assert!(text_of(&parts, "xl/worksheets/sheet2.xml").contains("<drawing r:id="));
    assert!(text_of(&parts, "xl/drawings/drawing2.xml").contains("<xdr:oneCellAnchor>"));
    assert!(
        text_of(&parts, "xl/drawings/_rels/drawing2.xml.rels").contains("../charts/chart2_4.xml")
    );

    let mut reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    reopened
        .apply(
            &ops(json!([
                {"op":"rename_sheet","sheet":"数据'明细","name":"统计"},
                {"op":"insert_rows","sheet":"统计","row":2},
                {"op":"delete_rows","sheet":"统计","row":4},
                {"op":"insert_columns","sheet":"统计","column":"B"},
                {"op":"set_cells","sheet":"统计","start":"C3","rows":[[12]]}
            ])),
            &images,
        )
        .unwrap();
    let view = reopened
        .read(&ReadRequest {
            sheet: Some("Charts 图表".into()),
            detail: Detail::Full,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        view["charts"][0]["series"][0]["values"],
        json!({"sheet":"统计","range":"D3:D4"})
    );
    let parts = assert_well_formed(&reopened.to_bytes().unwrap());
    let chart = text_of(&parts, "xl/charts/chart2_1.xml");
    assert!(chart.contains("$D$3:$D$4"));
    assert!(chart.contains("<c:v>24</c:v>"));
    assert!(!chart.contains("<c:v>40</c:v>"));
    // Replacing preserves its position; delete indexes address the current list.
    reopened.apply(&ops(json!([
        {"op":"replace_chart","sheet":"Charts 图表","index":0,"chart":{"type":"line","anchor":"A1","series":[{"categories":{"sheet":"统计","range":"A3:A4"},"values":{"sheet":"统计","range":"D3:D4"}}]}},
        {"op":"delete_chart","sheet":"Charts 图表","index":1}
    ])), &images).unwrap();
    let before = reopened.to_bytes().unwrap();
    for chart in [
        json!({"type":"column","anchor":"A1","series":[]}),
        json!({"type":"column","anchor":"A1","series":[{"categories":{"range":"A1:A3"},"values":{"range":"B1:B2"}}]}),
        json!({"type":"column","anchor":"A1","series":[{"categories":{"range":"A1:A2"},"values":{"range":"B1:B2"},"colour":"red"}]}),
    ] {
        assert!(reopened
            .apply(
                &[
                    json!({"op":"set_cells","sheet":"统计","rows":[["must roll back"]]}),
                    json!({"op":"add_chart","sheet":"统计","chart":chart})
                ],
                &images
            )
            .is_err());
        assert_eq!(reopened.to_bytes().unwrap(), before);
    }
    let report = reopened
        .apply(&[json!({"op":"delete_sheet","sheet":"统计"})], &images)
        .unwrap();
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("source range is unavailable")));
    let parts = assert_well_formed(&reopened.to_bytes().unwrap());
    assert!(text_of(&parts, "xl/charts/chart1_1.xml").contains("<c:f>#REF!</c:f>"));
}

#[test]
fn xlsx_style_only_updates_preserve_literals_formulas_and_reject_invalid_types() {
    let images = ImageSources::new();
    let mut book = OfficeDocument::new(OfficeFormat::Xlsx, None).unwrap();
    book.apply(&ops(json!([
        {"op":"add_sheet","name":"数据","rows":[[10,"=A1*2","保留"]]},
        {"op":"set_cells","rows":[[{"style":{"bold":true}},{"style":{"number_format":"0.00"}},null]]}
    ])), &images).unwrap();
    let read = ReadRequest {
        sheet: Some("数据".into()),
        range: Some("A1:C1".into()),
        detail: Detail::Full,
        ..Default::default()
    };
    let view = book.read(&read).unwrap();
    assert_eq!(
        view["rows"][0]["cells"],
        json!([10,{"formula":"=A1*2","value":20.0},"保留"])
    );
    let before = book.to_bytes().unwrap();
    for cell in [json!({"formula":42}), json!({"type":false,"value":10})] {
        assert!(book
            .apply(&[json!({"op":"set_cells","rows":[[cell]]})], &images)
            .is_err());
        assert_eq!(book.to_bytes().unwrap(), before);
    }
    book.apply(
        &[json!({"op":"set_cells","rows":[[{"value":null}]]})],
        &images,
    )
    .unwrap();
    assert!(book.read(&read).unwrap()["rows"][0]["cells"][0].is_null());
}

#[test]
fn docx_replacement_covers_formatted_text_without_crossing_content_boundaries() {
    let images = ImageSources::new();
    let mut doc = OfficeDocument::new(
        OfficeFormat::Docx,
        Some(&json!({"styles":{"lang":"zh-CN"}})),
    )
    .unwrap();
    doc.apply(&ops(json!([
        {"op":"set_header_footer","header":"旧项目 · Header","footer":"旧项目 · {PAGE}/{NUMPAGES}"},
        {"op":"insert_blocks","blocks":[
            {"type":"heading","level":1,"text":"中文报告 · Word"},
            {"type":"paragraph","runs":[{"text":"前缀 旧","bold":true},{"text":"项目 后缀","italic":true}]},
            {"type":"table","rows":[["指标","数值"],[{"runs":[{"text":"旧","bold":true},{"text":"项目"}]},42]],"caption":"旧项目 · 表格"},
            {"type":"code","text":"旧项目 = 42"},
            {"type":"list","items":["旧", "项目"]},
            {"type":"paragraph","text":"日本語の文章"},
            {"type":"paragraph","runs":[{"text":"한국어 문장","lang":"ko-KR"}]},
            {"type":"paragraph","text":"Emoji 🙂 · English 123"}
        ]},
        {"op":"replace_text","find":"旧项目","replace":"新产品"}
    ])), &images).unwrap();
    let view = doc
        .read(&ReadRequest {
            detail: Detail::Full,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(view["blocks"][1]["runs"][0]["text"], "前缀 新产品");
    assert_eq!(view["blocks"][1]["runs"][1]["text"], " 后缀");
    assert_eq!(view["blocks"][1]["runs"][0]["bold"], true);
    assert_eq!(view["blocks"][1]["runs"][1]["italic"], true);
    assert_eq!(view["blocks"][3]["text"], "新产品 = 42");
    assert_eq!(view["blocks"][4]["items"][0]["runs"][0]["text"], "旧");
    let parts = assert_well_formed(&doc.to_bytes().unwrap());
    assert!(text_of(&parts, "word/header1.xml").contains("旧项目"));
    assert!(text_of(&parts, "word/document.xml").contains("新产品 · 表格"));
    doc.apply(&[json!({"op":"replace_text","find":"旧项目","replace":"新产品","include_headers_footers":true})], &images).unwrap();
    let bytes = doc.to_bytes().unwrap();
    keep_sample("word-edits.docx", &bytes);
    let parts = assert_well_formed(&bytes);
    assert!(text_of(&parts, "word/header1.xml").contains("新产品"));
    assert!(text_of(&parts, "word/footer1.xml").contains("NUMPAGES"));
    assert!(text_of(&parts, "word/styles.xml").contains("w:eastAsia=\"zh-CN\""));
    assert!(text_of(&parts, "word/document.xml").contains("w:eastAsia=\"ko-KR\""));
    let code_font = "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/>";
    assert!(text_of(&parts, "word/document.xml").contains(code_font));
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    assert_eq!(
        reopened
            .read(&ReadRequest {
                detail: Detail::Full,
                ..Default::default()
            })
            .unwrap(),
        doc.read(&ReadRequest {
            detail: Detail::Full,
            ..Default::default()
        })
        .unwrap()
    );
    for block in [
        json!({"type":"table","rows":[[{"text":"too wide","colspan":63},"extra"]]}),
        json!({"type":"table","rows":[["bad size"]],"font_size_pt":-2}),
    ] {
        assert!(doc
            .apply(&[json!({"op":"insert_blocks","blocks":[block]})], &images)
            .is_err());
        assert_eq!(doc.to_bytes().unwrap(), bytes);
    }
}

#[test]
fn legacy_word_and_excel_models_keep_defaults_and_unknown_fields() {
    use openbitfun_office_documents::{docx::DocxDocument, xlsx::XlsxDocument};
    // Hand-authored old shapes, not snapshots generated by the current writer.
    let word =
        json!({"blocks":[{"type":"paragraph","runs":[{"text":"旧文档"}]}],"future":{"value":1}});
    let doc: DocxDocument = serde_json::from_value(word).unwrap();
    assert!(doc.styles.lang.is_none());
    assert!(serde_json::to_value(&doc).unwrap()["blocks"][0]["runs"][0]
        .get("math")
        .is_none());
    let round_trip = serde_json::to_value(doc).unwrap();
    assert_eq!(round_trip["future"], json!({"value":1}));
    assert!(round_trip["styles"].get("lang").is_none());
    let workbook = json!({"sheets":[{"name":"旧表","cells":{"A1":{"value":"中文"}},"future_sheet":{"value":2}}]});
    let book: XlsxDocument = serde_json::from_value(workbook).unwrap();
    assert!(book.sheets[0].charts.is_empty());
    let round_trip = serde_json::to_value(book).unwrap();
    assert_eq!(round_trip["sheets"][0]["cells"]["A1"]["value"], "中文");
    assert_eq!(round_trip["sheets"][0]["future_sheet"], json!({"value":2}));
    assert!(round_trip["sheets"][0].get("charts").is_none());
}

#[test]
fn academic_word_preserves_structure_and_native_latex_equations_across_edits() {
    let images = ImageSources::new();
    let mut doc = OfficeDocument::new(
        OfficeFormat::Docx,
        Some(&json!({
            "styles":{"font":"Times New Roman","font_size_pt":12,"line_spacing":1.5},
            "page":{"size":"a4","margins_cm":{"top":2.5,"bottom":2.5,"left":2.5,"right":2.5}}
        })),
    )
    .unwrap();
    let source = r#"# 论文排版与公式验证 / Academic Paper

## 摘要

这是一份用于验证文档生成的测试论文，不包含真实研究结论。本文检查行内公式 $E=mc^2$ 与跨页结构。引用标记 [1] 按正文文本保留。

[TOC]

<!-- pagebreak -->

## 1 方法

### 1.1 二次方程

独立公式应当生成可编辑的 Word 公式，而不是显示 TeX 源码：

$$x = \frac{-b\pm\sqrt{b^2-4ac}}{2a}$$

### 1.2 求和与积分

$$S_n = \sum_{i=1}^{n} x_i^2$$

$$\int_0^1 x^2\,dx = \frac{1}{3}$$

### 1.3 矩阵与符号

$$A = \begin{pmatrix}a&b\\c&d\end{pmatrix}$$

行内变量 $\hat{x}$、$\alpha$ 与 $\beta$ 保持公式语义。

## 2 验证结果

| 检查项 | 预期 |
| --- | --- |
| 分式与根号 | 原生公式 |
| 目录与标题 | 可读结构 |
| 中文与 English | 原文保留 |

表 1：测试场景。这里只验证格式，不代表数学证明。

## 参考文献

[1] OpenBitFun. 文档生成验证样例，2026。此条目为测试数据。
"#;
    doc.apply(&ops(json!([
        {"op":"set_header_footer","header":"论文验证 · Academic Paper","footer":"{PAGE} / {NUMPAGES}"},
        {"op":"insert_blocks","markdown":source}
    ])), &images).unwrap();
    let bytes = doc.to_bytes().unwrap();
    keep_sample("academic-paper.docx", &bytes);
    let parts = assert_well_formed(&bytes);
    let xml = text_of(&parts, "word/document.xml");
    for native in [
        "<m:oMath>",
        "<m:oMathPara>",
        "<m:f>",
        "<m:rad>",
        "<m:sSup>",
        "<m:m>",
        "TOC",
        "Heading2",
        "<w:tbl>",
    ] {
        assert!(xml.contains(native), "missing {native}");
    }
    assert!(!xml.contains("\\frac"));
    assert!(!xml.contains("\\begin{pmatrix}"));
    let mut reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let full = ReadRequest {
        detail: Detail::Full,
        limit: Some(100),
        ..Default::default()
    };
    let view = reopened.read(&full).unwrap();
    assert!(view.to_string().contains("\\\\frac"));
    let equation_index = view["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .position(|block| {
            block["runs"][0]["text"]
                .as_str()
                .is_some_and(|text| text.starts_with("S_n"))
        })
        .unwrap();
    reopened.apply(&[json!({"op":"replace_blocks","index":equation_index,"blocks":[{"type":"paragraph","runs":[{"text":"S_n = \\sum_{i=1}^{n} i","math":"display"}]}]})], &images).unwrap();
    // Text replacement must not alter LaTeX source or match across a formula.
    reopened
        .apply(
            &[json!({"op":"replace_text","find":"S_n","replace":"changed"})],
            &images,
        )
        .unwrap();
    assert!(
        reopened.read(&full).unwrap()["blocks"][equation_index]["runs"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("S_n")
    );
    let before = reopened.to_bytes().unwrap();
    for markdown in [r"Bad $\unknownCommand{x}$", r"Bad $\frac{1}$"] {
        assert!(reopened
            .apply(
                &[json!({"op":"insert_blocks","markdown":markdown})],
                &images
            )
            .is_err());
        assert_eq!(reopened.to_bytes().unwrap(), before);
    }
}

const FONT_SAMPLE_TEXT: &[(&str, &str)] = &[
    ("en-US", "English: Report & <data>"),
    ("zh-CN", "简体中文：工程规模与社区增长"),
    ("zh-TW", "繁體中文：工程規模與社群成長"),
    ("ja-JP", "日本語：プロジェクトの成長"),
    ("ko-KR", "한국어: 프로젝트 성장"),
    ("ar", "العربية: تقرير المشروع"),
];

#[test]
fn docx_font_scopes_and_reset_preserve_multilingual_content() {
    let mut doc = OfficeDocument::new(
        OfficeFormat::Docx,
        Some(&json!({"styles":{
            "font":"Legacy Latin", "east_asia_font":"Required CJK", "heading_font":"Heading Family",
            "complex_script_font":"Required Complex", "font_size_pt":12
        }})),
    )
    .unwrap();
    let mut blocks = vec![json!({"type":"heading","level":1,"text":"Font inheritance · 字体继承"})];
    blocks.extend(FONT_SAMPLE_TEXT.iter().map(|(lang, text)| {
        json!({"type":"paragraph","runs":[
            {"text":text,"lang":lang,"latin_font":"Arial"}
        ]})
    }));
    blocks.push(json!({"type":"table","rows":[["Scope","中文"],["Run override",{"runs":[{"text":"Mixed 中文","font":"Legacy All","east_asia_font":"Required CJK"}]}]]}));
    doc.apply(
        &[json!({"op":"insert_blocks","blocks":blocks})],
        &ImageSources::new(),
    )
    .unwrap();
    let parts = assert_well_formed(&doc.to_bytes().unwrap());
    let xml = text_of(&parts, "word/document.xml");
    let dom = roxmltree::Document::parse(&xml).unwrap();
    let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    for text in FONT_SAMPLE_TEXT.iter().map(|(_, text)| *text) {
        let run = dom
            .descendants()
            .find(|n| n.tag_name().name() == "t" && n.text() == Some(text))
            .unwrap()
            .parent()
            .unwrap();
        let fonts = run
            .descendants()
            .find(|n| n.tag_name().name() == "rFonts")
            .unwrap();
        assert_eq!(fonts.attribute((ns, "ascii")), Some("Arial"));
        assert_eq!(
            fonts.attribute((ns, "eastAsia")),
            None,
            "Latin-only choice must preserve CJK inheritance"
        );
        assert_eq!(fonts.attribute((ns, "cs")), None);
    }
    assert!(xml.contains("w:ascii=\"Legacy All\" w:hAnsi=\"Legacy All\" w:eastAsia=\"Required CJK\" w:cs=\"Legacy All\""));
    let styles = text_of(&parts, "word/styles.xml");
    assert!(styles.contains("w:cs=\"Required Complex\""));
    doc.apply(&ops(json!([
        {"op":"set_styles","font":null,"heading_font":null,"east_asia_font":null,"complex_script_font":null},
        {"op":"replace_blocks","index":7,"blocks":[{"type":"table","rows":[["Scope","中文"],["Default font restored","内容保留"]]}]}
    ])), &ImageSources::new()).unwrap();
    let bytes = doc.to_bytes().unwrap();
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let view = reopened
        .read(&ReadRequest {
            detail: Detail::Full,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(view["settings"]["styles"]["font_size_pt"], 12.0);
    for (_, text) in FONT_SAMPLE_TEXT {
        assert!(view.to_string().contains(text));
    }
    let parts = assert_well_formed(&bytes);
    assert!(!text_of(&parts, "word/styles.xml").contains("w:eastAsia="));
    assert!(!text_of(&parts, "word/document.xml").contains("Required CJK"));
    keep_sample("font-inheritance.docx", &reopened.to_bytes().unwrap());
}

#[test]
fn pptx_font_precedence_and_reset_preserve_theme_and_content() {
    let images = ImageSources::new();
    let mut deck=OfficeDocument::new(OfficeFormat::Pptx,Some(&json!({"theme":{"font":"Theme Latin","east_asia_font":"Theme East","complex_script_font":"Theme Complex"}}))).unwrap();
    deck.apply(&[json!({"op":"insert_slides","slides":[{"elements":[
        {"type":"text","x":40,"y":40,"w":1100,"h":200,"font":"Element All","east_asia_font":"Element East","paragraphs":[
            {"font":"Paragraph All","east_asia_font":"Paragraph East","runs":[
                {"text":"first","font":"Run All","latin_font":"Run Latin"},
                {"text":"second","complex_script_font":"Run Complex"}
            ]}
        ]}
    ]}]})],&images).unwrap();
    let parts = assert_well_formed(&deck.to_bytes().unwrap());
    let xml = text_of(&parts, "ppt/slides/slide1.xml");
    let dom = roxmltree::Document::parse(&xml).unwrap();
    for (text, expected) in [
        ("first", ["Run Latin", "Run All", "Run All"]),
        ("second", ["Paragraph All", "Paragraph East", "Run Complex"]),
    ] {
        let run = dom
            .descendants()
            .find(|n| n.tag_name().name() == "t" && n.text() == Some(text))
            .unwrap()
            .parent()
            .unwrap();
        for (slot, font) in ["latin", "ea", "cs"].into_iter().zip(expected) {
            assert_eq!(
                run.descendants()
                    .find(|n| n.tag_name().name() == slot)
                    .unwrap()
                    .attribute("typeface"),
                Some(font)
            );
        }
    }
    let end = dom
        .descendants()
        .find(|n| n.tag_name().name() == "endParaRPr")
        .unwrap();
    assert_eq!(
        end.children()
            .find(|n| n.tag_name().name() == "ea")
            .unwrap()
            .attribute("typeface"),
        Some("Paragraph East")
    );
    // Removal through patches restores inherited defaults; replacement retains all text.
    deck.apply(&ops(json!([
        {"op":"set_theme","font":null,"east_asia_font":null,"complex_script_font":null},
        {"op":"update_slide","index":0,"update_elements":[{"index":0,"font":null,"east_asia_font":null,"latin_font":"Arial","paragraphs":[{"text":"Updated 中文","lang":"zh-CN"}]}]}
    ])),&images).unwrap();
    let parts = assert_well_formed(&deck.to_bytes().unwrap());
    let xml = text_of(&parts, "ppt/slides/slide1.xml");
    assert!(!xml.contains("<a:ea "));
    assert!(xml.contains("<a:latin typeface=\"Arial\"/>"));
    assert!(xml.contains("Updated 中文"));
    let elements:Vec<_>=FONT_SAMPLE_TEXT.iter().enumerate().map(|(i,(lang,text))|json!({
        "type":"text","x":64,"y":60+i*80,"w":1140,"h":62,"size_pt":26,"latin_font":"Arial","text":text,"lang":lang
    })).collect();
    deck.apply(&[json!({"op":"update_slide","index":0,"elements":elements,"notes":"中文 notes: default East Asian fonts, Latin-only override."})],&images).unwrap();
    let bytes = deck.to_bytes().unwrap();
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    for (_, text) in FONT_SAMPLE_TEXT {
        assert!(reopened
            .read(&ReadRequest {
                detail: Detail::Full,
                ..Default::default()
            })
            .unwrap()
            .to_string()
            .contains(text));
    }
    keep_sample("font-inheritance.pptx", &reopened.to_bytes().unwrap());
}

#[test]
fn xlsx_font_reset_preserves_values_formulas_and_other_styles() {
    let images = ImageSources::new();
    let mut book = OfficeDocument::new(OfficeFormat::Xlsx, None).unwrap();
    let mut rows = vec![json!([
        "Language",
        "Default / 默认",
        "Reset font / 恢复字体",
        "Amount",
        "Formula"
    ])];
    rows.extend(
        FONT_SAMPLE_TEXT
            .iter()
            .enumerate()
            .map(|(i, (lang, text))| json!([lang, text, text, i + 1, format!("=D{}*2", i + 2)])),
    );
    book.apply(&ops(json!([
        {"op":"add_sheet","name":"Fonts 字体","rows":rows},
        {"op":"format_range","range":"C2:E7","style":{"font_name":"Unverified Family","bold":true,"font_color":"#1F4E79","number_format":"0.00"}},
        {"op":"format_range","range":"A1:E1","style":{"bold":true,"fill_color":"#D9E2F3"}},
        {"op":"set_column_widths","widths":{"A":12,"B:C":40,"D:E":14}},
        {"op":"set_row_heights","heights":{"1:7":30}}
    ])),&images).unwrap();
    // Null kept its legacy no-op meaning; clearing uses an explicit operation flag.
    book.apply(
        &[json!({"op":"format_range","range":"C2:E7","style":{"font_name":null}})],
        &images,
    )
    .unwrap();
    assert!(
        text_of(&entries(&book.to_bytes().unwrap()), "xl/styles.xml").contains("Unverified Family")
    );
    book.apply(
        &[json!({"op":"format_range","range":"C2:E7","reset_font":true,"style":{}})],
        &images,
    )
    .unwrap();
    let bytes = book.to_bytes().unwrap();
    let parts = assert_well_formed(&bytes);
    let styles = text_of(&parts, "xl/styles.xml");
    assert!(!styles.contains("Unverified Family"));
    let source: Value = serde_json::from_slice(&parts["openbitfun/genoffice.json"]).unwrap();
    let cells = &source["document"]["sheets"][0]["cells"];
    assert_eq!(cells["C2"]["value"], FONT_SAMPLE_TEXT[0].1);
    assert_eq!(cells["D2"]["value"], 1);
    assert_eq!(cells["E2"]["formula"], "D2*2");
    for name in ["C2", "D2", "E2"] {
        assert_eq!(cells[name]["style"]["bold"], true);
        assert_eq!(cells[name]["style"]["number_format"], "0.00");
        assert_eq!(cells[name]["style"]["font_color"], "#1F4E79");
        assert!(cells[name]["style"].get("font_name").is_none());
    }
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    keep_sample("font-inheritance.xlsx", &reopened.to_bytes().unwrap());
    // A custom font name does not imply a Swiss/sans-serif font classification.
    book.apply(
        &[json!({"op":"format_range","range":"B2","style":{"font_name":"Required Serif"}})],
        &images,
    )
    .unwrap();
    let styles = text_of(&entries(&book.to_bytes().unwrap()), "xl/styles.xml");
    let dom = roxmltree::Document::parse(&styles).unwrap();
    let font = dom
        .descendants()
        .find(|n| n.tag_name().name() == "name" && n.attribute("val") == Some("Required Serif"))
        .unwrap()
        .parent()
        .unwrap();
    assert!(!font.children().any(|n| n.tag_name().name() == "family"));
}

#[test]
fn font_input_errors_are_atomic_and_existing_v1_names_stay_readable() {
    for (format, initial, bad) in [
        (
            OfficeFormat::Docx,
            json!({"op":"insert_blocks","markdown":"中文 original"}),
            json!({"op":"set_styles","east_asia_font":" "}),
        ),
        (
            OfficeFormat::Pptx,
            json!({"op":"insert_slides","slides":[{"elements":[]}]}),
            json!({"op":"set_theme","font":"bad\nname"}),
        ),
        (
            OfficeFormat::Xlsx,
            json!({"op":"add_sheet","name":"Data","rows":[["中文 original"]]}),
            json!({"op":"format_range","range":"A1","style":{"font_name":12}}),
        ),
    ] {
        let mut doc = OfficeDocument::new(format, None).unwrap();
        doc.apply(&[initial], &ImageSources::new()).unwrap();
        let before = doc.to_bytes().unwrap();
        let error = doc.apply(&[bad], &ImageSources::new()).unwrap_err();
        assert_eq!(error.operation_index, Some(0));
        assert!(error.to_string().contains("font"));
        assert_eq!(doc.to_bytes().unwrap(), before);
    }
    // Hand-authored old payload: no script-specific fields; an old empty name is
    // preserved rather than making the record unreadable or resetting user data.
    let legacy=br#"{"schema":"openbitfun.genoffice","version":1,"format":"docx","revision":4,"document":{"styles":{"font":"Legacy All","east_asia_font":""},"blocks":[{"type":"paragraph","runs":[{"text":"\u4e2d\u6587","font":"Legacy Run"}]}]}}"#;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(
        "openbitfun/genoffice.json",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(legacy).unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let mut doc = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    doc.apply(
        &[json!({"op":"set_properties","title":"Unrelated edit"})],
        &ImageSources::new(),
    )
    .unwrap();
    let bytes = doc.to_bytes().unwrap();
    let parts = assert_well_formed(&bytes);
    assert!(text_of(&parts,"word/document.xml").contains("w:ascii=\"Legacy Run\" w:hAnsi=\"Legacy Run\" w:eastAsia=\"Legacy Run\" w:cs=\"Legacy Run\""));
    let reopened = OfficeDocument::open(&bytes, &OpenOptions::default()).unwrap();
    let view = reopened
        .read(&ReadRequest {
            detail: Detail::Full,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(view["settings"]["styles"]["east_asia_font"], "");
    assert_eq!(view["blocks"][0]["runs"][0]["font"], "Legacy Run");
    assert!(view["blocks"][0]["runs"][0].get("latin_font").is_none());
}
