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
