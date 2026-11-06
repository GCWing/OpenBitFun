//! WordprocessingML package writer.

use super::model::{
    cm_to_twips, Block, DocxDocument, HeaderFooter, ImageBlock, ListBlock, Orientation,
    ParagraphBlock, ParagraphStyle, TableBlock, TocBlock,
};
use crate::common::{parse_color, runs_text, Align, Run, TableCell};
use crate::error::{OfficeError, OfficeResult};
use crate::image::{kind_of_asset, sniff};
use crate::package::{add_common_parts, ContentTypes, Parts, Relationships};
use crate::xml::{esc, needs_preserve, XML_HEADER};
use std::collections::BTreeMap;

const NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"";
const REL_STYLES: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
const REL_SETTINGS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings";
const REL_NUMBERING: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering";
const REL_HEADER: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
const REL_FOOTER: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_HYPERLINK: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const EMU_PER_TWIP: u64 = 635;
const EMU_PER_CM: f64 = 360_000.0;
const EMU_PER_PX: u64 = 9525;

struct Writer<'a> {
    doc: &'a DocxDocument,
    assets: &'a BTreeMap<String, Vec<u8>>,
    rels: Relationships,
    image_rels: BTreeMap<String, String>,
    link_rels: BTreeMap<String, String>,
    used_assets: Vec<String>,
    /// (numId, ordered, start) for every list block in order.
    lists: Vec<(u32, bool, u32)>,
    drawing_id: u32,
    has_toc: bool,
}

pub(crate) fn render(
    doc: &DocxDocument,
    assets: &BTreeMap<String, Vec<u8>>,
    created: Option<&str>,
    modified: Option<&str>,
) -> OfficeResult<Parts> {
    let mut writer = Writer {
        doc,
        assets,
        rels: Relationships::default(),
        image_rels: BTreeMap::new(),
        link_rels: BTreeMap::new(),
        used_assets: Vec::new(),
        lists: Vec::new(),
        drawing_id: 0,
        has_toc: false,
    };
    writer.rels.add(REL_STYLES, "styles.xml");
    writer.rels.add(REL_SETTINGS, "settings.xml");
    let body = writer.body()?;

    let mut types = ContentTypes::new();
    let mut parts = Parts::default();
    types.part(
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    );
    types.part(
        "word/styles.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
    );
    types.part(
        "word/settings.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
    );

    if !writer.lists.is_empty() {
        writer.rels.add(REL_NUMBERING, "numbering.xml");
        types.part(
            "word/numbering.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
        );
        parts.add_xml("word/numbering.xml", numbering_xml(&writer.lists));
    }

    let header_rel = doc.header.as_ref().map(|header| {
        types.part(
            "word/header1.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
        );
        parts.add_xml("word/header1.xml", header_footer_xml("hdr", header));
        writer.rels.add(REL_HEADER, "header1.xml")
    });
    let footer_rel = doc.footer.as_ref().map(|footer| {
        types.part(
            "word/footer1.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
        );
        parts.add_xml("word/footer1.xml", header_footer_xml("ftr", footer));
        writer.rels.add(REL_FOOTER, "footer1.xml")
    });

    let mut document = String::from(XML_HEADER);
    document.push_str(&format!("<w:document {NS}><w:body>"));
    document.push_str(&body);
    document.push_str(&section_xml(
        doc,
        header_rel.as_deref(),
        footer_rel.as_deref(),
    ));
    document.push_str("</w:body></w:document>");

    parts.add_xml("word/document.xml", document);
    parts.add_xml("word/styles.xml", styles_xml(doc));
    parts.add_xml("word/settings.xml", settings_xml(writer.has_toc));
    parts.add_xml("word/_rels/document.xml.rels", writer.rels.xml());
    for asset in &writer.used_assets {
        let bytes = assets
            .get(asset)
            .ok_or_else(|| OfficeError::corrupt(format!("embedded picture {asset} is missing")))?;
        if let Some(kind) = kind_of_asset(asset) {
            types.extension(kind.extension(), kind.content_type());
        }
        parts.add(format!("word/media/{asset}"), bytes.clone());
    }
    add_common_parts(
        &mut parts,
        &mut types,
        "word/document.xml",
        &doc.properties,
        created,
        modified,
        "OpenBitFun GenOfficeFile",
    );
    parts.add_xml("[Content_Types].xml", types.xml());
    Ok(parts)
}

impl Writer<'_> {
    fn body(&mut self) -> OfficeResult<String> {
        let mut out = String::new();
        let blocks = &self.doc.blocks;
        for (index, block) in blocks.iter().enumerate() {
            match block {
                Block::Heading(heading) => {
                    let mut ppr = format!("<w:pStyle w:val=\"Heading{}\"/>", heading.level);
                    ppr.push_str(&jc(heading.align));
                    out.push_str(&self.paragraph(&ppr, &heading.runs, None));
                }
                Block::Paragraph(paragraph) => out.push_str(&self.plain_paragraph(paragraph)),
                Block::List(list) => out.push_str(&self.list(list)),
                Block::Table(table) => {
                    out.push_str(&self.table(table));
                    let next_is_table = matches!(blocks.get(index + 1), Some(Block::Table(_)) | None);
                    if next_is_table {
                        // Word merges adjacent tables and wants a paragraph before sectPr.
                        out.push_str("<w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr></w:p>");
                    }
                }
                Block::Image(image) => out.push_str(&self.image(image)?),
                Block::Code(code) => {
                    let run = Run {
                        text: code.text.clone(),
                        code: Some(true),
                        ..Run::default()
                    };
                    out.push_str(&self.paragraph("<w:pStyle w:val=\"Code\"/>", &[run], None));
                }
                Block::Quote(quote) => {
                    out.push_str(&self.paragraph("<w:pStyle w:val=\"Quote\"/>", &quote.runs, None))
                }
                Block::PageBreak(_) => {
                    out.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
                }
                Block::HorizontalRule(_) => out.push_str(
                    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"A6A6A6\"/></w:pBdr></w:pPr></w:p>",
                ),
                Block::Toc(toc) => out.push_str(&self.toc(toc)),
            }
        }
        Ok(out)
    }

    fn plain_paragraph(&mut self, paragraph: &ParagraphBlock) -> String {
        let mut ppr = String::new();
        let style = match paragraph.style {
            Some(ParagraphStyle::Title) => Some("Title"),
            Some(ParagraphStyle::Subtitle) => Some("Subtitle"),
            Some(ParagraphStyle::Caption) => Some("Caption"),
            Some(ParagraphStyle::Normal) | None => None,
        };
        if let Some(style) = style {
            ppr.push_str(&format!("<w:pStyle w:val=\"{style}\"/>"));
        }
        if paragraph.space_before_pt.is_some()
            || paragraph.space_after_pt.is_some()
            || paragraph.line_spacing.is_some()
        {
            ppr.push_str("<w:spacing");
            if let Some(before) = paragraph.space_before_pt {
                ppr.push_str(&format!(" w:before=\"{}\"", pt_twips(before)));
            }
            if let Some(after) = paragraph.space_after_pt {
                ppr.push_str(&format!(" w:after=\"{}\"", pt_twips(after)));
            }
            if let Some(line) = paragraph.line_spacing {
                ppr.push_str(&format!(
                    " w:line=\"{}\" w:lineRule=\"auto\"",
                    (line * 240.0).round() as i64
                ));
            }
            ppr.push_str("/>");
        }
        if paragraph.indent_cm.is_some() || paragraph.first_line_indent_cm.is_some() {
            ppr.push_str("<w:ind");
            if let Some(left) = paragraph.indent_cm {
                ppr.push_str(&format!(" w:left=\"{}\"", cm_to_twips(left.max(0.0))));
            }
            if let Some(first) = paragraph.first_line_indent_cm {
                if first >= 0.0 {
                    ppr.push_str(&format!(" w:firstLine=\"{}\"", cm_to_twips(first)));
                } else {
                    ppr.push_str(&format!(" w:hanging=\"{}\"", cm_to_twips(-first)));
                }
            }
            ppr.push_str("/>");
        }
        ppr.push_str(&jc(paragraph.align));
        self.paragraph(&ppr, &paragraph.runs, None)
    }

    fn paragraph(&mut self, ppr: &str, runs: &[Run], defaults: Option<&RunDefaults>) -> String {
        let mut out = String::from("<w:p>");
        if !ppr.is_empty() {
            out.push_str(&format!("<w:pPr>{ppr}</w:pPr>"));
        }
        for run in runs {
            out.push_str(&self.run(run, defaults));
        }
        out.push_str("</w:p>");
        out
    }

    fn run(&mut self, run: &Run, defaults: Option<&RunDefaults>) -> String {
        let link = run.link.as_ref().map(|target| {
            self.link_rels
                .entry(target.clone())
                .or_insert_with(|| self.rels.add_external(REL_HYPERLINK, target))
                .clone()
        });
        let mut rpr = String::new();
        if link.is_some() {
            rpr.push_str("<w:rStyle w:val=\"Hyperlink\"/>");
        }
        let font = run
            .font
            .as_deref()
            .or_else(|| (run.code == Some(true)).then_some("Consolas"));
        if let Some(font) = font {
            let font = esc(font);
            rpr.push_str(&format!(
                "<w:rFonts w:ascii=\"{font}\" w:hAnsi=\"{font}\" w:eastAsia=\"{font}\" w:cs=\"{font}\"/>"
            ));
        }
        let bold = run.bold.or(defaults.and_then(|d| d.bold));
        if bold == Some(true) {
            rpr.push_str("<w:b/><w:bCs/>");
        }
        if run.italic == Some(true) {
            rpr.push_str("<w:i/><w:iCs/>");
        }
        if run.strike == Some(true) {
            rpr.push_str("<w:strike/>");
        }
        let color = run
            .color
            .as_deref()
            .or(defaults.and_then(|d| d.color.as_deref()));
        if let Some(color) = color.and_then(|value| parse_color(value).ok()) {
            rpr.push_str(&format!("<w:color w:val=\"{}\"/>", color.0));
        }
        let size = run.size_pt.or(defaults.and_then(|d| d.size_pt));
        if let Some(size) = size {
            let half_points = (size * 2.0).round() as i64;
            rpr.push_str(&format!(
                "<w:sz w:val=\"{half_points}\"/><w:szCs w:val=\"{half_points}\"/>"
            ));
        }
        if run.underline == Some(true) {
            rpr.push_str("<w:u w:val=\"single\"/>");
        }
        let shade = run
            .highlight
            .as_deref()
            .and_then(|value| parse_color(value).ok())
            .map(|color| color.0)
            .or_else(|| (run.code == Some(true)).then(|| "F2F2F2".to_string()));
        if let Some(fill) = shade {
            rpr.push_str(&format!(
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/>"
            ));
        }
        if run.superscript == Some(true) {
            rpr.push_str("<w:vertAlign w:val=\"superscript\"/>");
        } else if run.subscript == Some(true) {
            rpr.push_str("<w:vertAlign w:val=\"subscript\"/>");
        }
        if let Some(lang) = &run.lang {
            let lang = esc(lang);
            rpr.push_str(&format!(
                "<w:lang w:val=\"{lang}\" w:eastAsia=\"{lang}\" w:bidi=\"{lang}\"/>"
            ));
        }
        let mut out = String::from("<w:r>");
        if !rpr.is_empty() {
            out.push_str(&format!("<w:rPr>{rpr}</w:rPr>"));
        }
        out.push_str(&text_content(&run.text));
        out.push_str("</w:r>");
        match link {
            Some(id) => format!("<w:hyperlink r:id=\"{id}\" w:history=\"1\">{out}</w:hyperlink>"),
            None => out,
        }
    }

    fn list(&mut self, list: &ListBlock) -> String {
        let num_id = self.lists.len() as u32 + 1;
        self.lists
            .push((num_id, list.ordered, list.start.unwrap_or(1).max(1)));
        let mut out = String::new();
        for item in &list.items {
            let ppr = format!(
                "<w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{num_id}\"/></w:numPr>",
                item.level.min(8)
            );
            out.push_str(&self.paragraph(&ppr, &item.runs, None));
        }
        out
    }

    fn table(&mut self, table: &TableBlock) -> String {
        let columns = table
            .rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|cell| cell.colspan.unwrap_or(1) as usize)
                    .sum::<usize>()
            })
            .max()
            .unwrap_or(1)
            .max(1);
        let text_width = self.doc.page.text_width_twips() as f64;
        let widths: Vec<u32> = match &table.column_widths_cm {
            Some(widths) if !widths.is_empty() => (0..columns)
                .map(|index| {
                    cm_to_twips(
                        *widths
                            .get(index)
                            .unwrap_or_else(|| widths.last().expect("non-empty")),
                    )
                })
                .collect(),
            _ => vec![(text_width / columns as f64).floor() as u32; columns],
        };
        let mut out = String::new();
        if let Some(caption) = &table.caption {
            out.push_str(&self.paragraph(
                "<w:pStyle w:val=\"Caption\"/><w:keepNext/>",
                &[Run::plain(caption.clone())],
                None,
            ));
        }
        out.push_str("<w:tbl><w:tblPr>");
        let total: u32 = widths.iter().sum();
        out.push_str(&format!("<w:tblW w:w=\"{total}\" w:type=\"dxa\"/>"));
        if table.borders {
            out.push_str("<w:tblBorders>");
            for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
                out.push_str(&format!(
                    "<w:{side} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"A6A6A6\"/>"
                ));
            }
            out.push_str("</w:tblBorders>");
        }
        out.push_str("<w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:top w:w=\"40\" w:type=\"dxa\"/><w:left w:w=\"100\" w:type=\"dxa\"/><w:bottom w:w=\"40\" w:type=\"dxa\"/><w:right w:w=\"100\" w:type=\"dxa\"/></w:tblCellMar><w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>");
        for width in &widths {
            out.push_str(&format!("<w:gridCol w:w=\"{width}\"/>"));
        }
        out.push_str("</w:tblGrid>");
        let header_fill = parse_color(&self.doc.styles.table_header_fill)
            .map(|color| color.0)
            .unwrap_or_else(|_| "D9E2F3".to_string());
        for (row_index, row) in table.rows.iter().enumerate() {
            let is_header = (row_index as u32) < table.header_rows;
            out.push_str("<w:tr>");
            if is_header {
                out.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            let mut column = 0;
            for cell in row {
                if column >= columns {
                    break;
                }
                let span = (cell.colspan.unwrap_or(1) as usize).clamp(1, columns - column);
                let width: u32 = widths[column..column + span].iter().sum();
                out.push_str(&self.table_cell(
                    cell,
                    width,
                    span,
                    is_header,
                    &header_fill,
                    table.font_size_pt,
                ));
                column += span;
            }
            while column < columns {
                out.push_str(&self.table_cell(
                    &TableCell::default(),
                    widths[column],
                    1,
                    is_header,
                    &header_fill,
                    table.font_size_pt,
                ));
                column += 1;
            }
            out.push_str("</w:tr>");
        }
        out.push_str("</w:tbl>");
        out
    }

    fn table_cell(
        &mut self,
        cell: &TableCell,
        width: u32,
        span: usize,
        is_header: bool,
        header_fill: &str,
        font_size: Option<f64>,
    ) -> String {
        let mut out = format!("<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/>");
        if span > 1 {
            out.push_str(&format!("<w:gridSpan w:val=\"{span}\"/>"));
        }
        let fill = cell
            .fill
            .as_deref()
            .and_then(|value| parse_color(value).ok())
            .map(|color| color.0)
            .or_else(|| is_header.then(|| header_fill.to_string()));
        if let Some(fill) = fill {
            out.push_str(&format!(
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/>"
            ));
        }
        out.push_str("<w:vAlign w:val=\"center\"/></w:tcPr>");
        let defaults = RunDefaults {
            bold: cell.bold.or(is_header.then_some(true)),
            color: cell.color.clone(),
            size_pt: font_size,
        };
        let mut ppr = String::from("<w:spacing w:before=\"0\" w:after=\"0\"/>");
        ppr.push_str(&jc(cell.align));
        out.push_str(&self.paragraph(&ppr, &cell.runs, Some(&defaults)));
        out.push_str("</w:tc>");
        out
    }

    fn image(&mut self, image: &ImageBlock) -> OfficeResult<String> {
        let asset = image
            .asset
            .as_deref()
            .ok_or_else(|| OfficeError::corrupt("image block without an embedded picture"))?;
        let bytes = self
            .assets
            .get(asset)
            .ok_or_else(|| OfficeError::corrupt(format!("embedded picture {asset} is missing")))?;
        let info = sniff(bytes)?;
        let rel = match self.image_rels.get(asset) {
            Some(rel) => rel.clone(),
            None => {
                let rel = self.rels.add(REL_IMAGE, &format!("media/{asset}"));
                self.image_rels.insert(asset.to_string(), rel.clone());
                self.used_assets.push(asset.to_string());
                rel
            }
        };
        let max_width = self.doc.page.text_width_twips() as u64 * EMU_PER_TWIP;
        let aspect = info.height as f64 / info.width as f64;
        let (cx, cy) = match (image.width_cm, image.height_cm) {
            (Some(width), Some(height)) => (width * EMU_PER_CM, height * EMU_PER_CM),
            (Some(width), None) => (width * EMU_PER_CM, width * EMU_PER_CM * aspect),
            (None, Some(height)) => (height * EMU_PER_CM / aspect, height * EMU_PER_CM),
            (None, None) => {
                let natural = (info.width as u64 * EMU_PER_PX) as f64;
                let width = natural.min(max_width as f64);
                (width, width * aspect)
            }
        };
        let (cx, cy) = (cx.round().max(1.0) as u64, cy.round().max(1.0) as u64);
        self.drawing_id += 1;
        let id = self.drawing_id;
        let descr = esc(image
            .alt
            .as_deref()
            .or(image.caption.as_deref())
            .unwrap_or(""));
        let mut out = format!("<w:p><w:pPr><w:spacing w:after=\"80\"/>{}</w:pPr><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:docPr id=\"{id}\" name=\"Picture {id}\" descr=\"{descr}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{rel}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
            jc(image.align.or(Some(Align::Center))),
            esc(asset),
        );
        if let Some(caption) = &image.caption {
            out.push_str(&self.paragraph(
                &format!(
                    "<w:pStyle w:val=\"Caption\"/>{}",
                    jc(image.align.or(Some(Align::Center)))
                ),
                &[Run::plain(caption.clone())],
                None,
            ));
        }
        Ok(out)
    }

    fn toc(&mut self, toc: &TocBlock) -> String {
        self.has_toc = true;
        let mut out = String::new();
        if let Some(title) = &toc.title {
            out.push_str(&self.paragraph(
                "<w:pStyle w:val=\"TOCHeading\"/>",
                &[Run::plain(title.clone())],
                None,
            ));
        }
        let tab = self.doc.page.text_width_twips();
        let entries: Vec<(u8, String)> = self
            .doc
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Heading(heading) if heading.level <= toc.levels => {
                    Some((heading.level, runs_text(&heading.runs)))
                }
                _ => None,
            })
            .collect();
        let begin = format!(
            "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-{}\" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            toc.levels
        );
        let end = "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>";
        if entries.is_empty() {
            out.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"TOC1\"/></w:pPr>{begin}<w:r><w:t>Update this field to build the table of contents.</w:t></w:r>{end}</w:p>"
            ));
            return out;
        }
        let last = entries.len() - 1;
        for (index, (level, text)) in entries.iter().enumerate() {
            out.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"TOC{level}\"/><w:tabs><w:tab w:val=\"right\" w:leader=\"dot\" w:pos=\"{tab}\"/></w:tabs></w:pPr>"
            ));
            if index == 0 {
                out.push_str(&begin);
            }
            out.push_str(&format!("<w:r>{}</w:r>", text_content(text)));
            if index == last {
                out.push_str(end);
            }
            out.push_str("</w:p>");
        }
        out
    }
}

struct RunDefaults {
    bold: Option<bool>,
    color: Option<String>,
    size_pt: Option<f64>,
}

fn pt_twips(points: f64) -> i64 {
    (points.max(0.0) * 20.0).round() as i64
}

fn jc(align: Option<Align>) -> String {
    match align {
        Some(Align::Left) => "<w:jc w:val=\"left\"/>".to_string(),
        Some(Align::Center) => "<w:jc w:val=\"center\"/>".to_string(),
        Some(Align::Right) => "<w:jc w:val=\"right\"/>".to_string(),
        Some(Align::Justify) => "<w:jc w:val=\"both\"/>".to_string(),
        None => String::new(),
    }
}

/// Run content with line breaks and tabs as their own elements.
fn text_content(text: &str) -> String {
    let mut out = String::new();
    for (line_index, line) in text.split('\n').enumerate() {
        if line_index > 0 {
            out.push_str("<w:br/>");
        }
        for (tab_index, segment) in line.split('\t').enumerate() {
            if tab_index > 0 {
                out.push_str("<w:tab/>");
            }
            if segment.is_empty() {
                continue;
            }
            if needs_preserve(segment) {
                out.push_str(&format!(
                    "<w:t xml:space=\"preserve\">{}</w:t>",
                    esc(segment)
                ));
            } else {
                out.push_str(&format!("<w:t>{}</w:t>", esc(segment)));
            }
        }
    }
    out
}

fn section_xml(doc: &DocxDocument, header: Option<&str>, footer: Option<&str>) -> String {
    let (width, height) = doc.page.page_twips();
    let margins = &doc.page.margins_cm;
    let mut out = String::from("<w:sectPr>");
    if let Some(id) = header {
        out.push_str(&format!(
            "<w:headerReference w:type=\"default\" r:id=\"{id}\"/>"
        ));
    }
    if let Some(id) = footer {
        out.push_str(&format!(
            "<w:footerReference w:type=\"default\" r:id=\"{id}\"/>"
        ));
    }
    let orient = match doc.page.orientation {
        Orientation::Landscape => " w:orient=\"landscape\"",
        Orientation::Portrait => "",
    };
    out.push_str(&format!(
        "<w:pgSz w:w=\"{width}\" w:h=\"{height}\"{orient}/>"
    ));
    out.push_str(&format!(
        "<w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/>",
        cm_to_twips(margins.top),
        cm_to_twips(margins.right),
        cm_to_twips(margins.bottom),
        cm_to_twips(margins.left)
    ));
    out.push_str("<w:cols w:space=\"708\"/></w:sectPr>");
    out
}

fn header_footer_xml(tag: &str, part: &HeaderFooter) -> String {
    let style = if tag == "hdr" { "Header" } else { "Footer" };
    let mut content = String::new();
    let mut rest = part.text.as_str();
    while !rest.is_empty() {
        let next = ["{PAGE}", "{NUMPAGES}"]
            .iter()
            .filter_map(|token| rest.find(token).map(|position| (position, *token)))
            .min_by_key(|(position, _)| *position);
        match next {
            Some((position, token)) => {
                if position > 0 {
                    content.push_str(&format!("<w:r>{}</w:r>", text_content(&rest[..position])));
                }
                let field = token.trim_matches(|c| c == '{' || c == '}');
                content.push_str(&format!(
                    "<w:fldSimple w:instr=\" {field} \"><w:r><w:t>1</w:t></w:r></w:fldSimple>"
                ));
                rest = &rest[position + token.len()..];
            }
            None => {
                content.push_str(&format!("<w:r>{}</w:r>", text_content(rest)));
                rest = "";
            }
        }
    }
    format!(
        "{XML_HEADER}<w:{tag} {NS}><w:p><w:pPr><w:pStyle w:val=\"{style}\"/>{}</w:pPr>{content}</w:p></w:{tag}>",
        jc(Some(part.align))
    )
}

fn numbering_xml(lists: &[(u32, bool, u32)]) -> String {
    let mut out = String::from(XML_HEADER);
    out.push_str(
        "<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    );
    let bullets = ["•", "◦", "▪"];
    out.push_str(
        "<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"hybridMultilevel\"/>",
    );
    for level in 0..9u32 {
        out.push_str(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            bullets[level as usize % 3],
            720 + level * 360
        ));
    }
    out.push_str("</w:abstractNum>");
    let formats = ["decimal", "lowerLetter", "lowerRoman"];
    out.push_str(
        "<w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"hybridMultilevel\"/>",
    );
    for level in 0..9u32 {
        out.push_str(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{}\"/><w:lvlText w:val=\"%{}.\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            formats[level as usize % 3],
            level + 1,
            720 + level * 360
        ));
    }
    out.push_str("</w:abstractNum>");
    for (num_id, ordered, start) in lists {
        let abstract_id = u32::from(*ordered);
        out.push_str(&format!(
            "<w:num w:numId=\"{num_id}\"><w:abstractNumId w:val=\"{abstract_id}\"/><w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"{start}\"/></w:lvlOverride></w:num>"
        ));
    }
    out.push_str("</w:numbering>");
    out
}

fn settings_xml(update_fields: bool) -> String {
    format!(
        "{XML_HEADER}<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:zoom w:percent=\"100\"/><w:defaultTabStop w:val=\"720\"/><w:characterSpacingControl w:val=\"doNotCompress\"/>{}<w:compat><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat></w:settings>",
        if update_fields {
            "<w:updateFields w:val=\"true\"/>"
        } else {
            ""
        }
    )
}

fn styles_xml(doc: &DocxDocument) -> String {
    let styles = &doc.styles;
    let font = esc(styles.font.as_deref().unwrap_or("Calibri"));
    let heading_font = esc(styles
        .heading_font
        .as_deref()
        .unwrap_or(styles.font.as_deref().unwrap_or("Calibri")));
    let east_asia = styles
        .east_asia_font
        .as_deref()
        .map(|value| format!(" w:eastAsia=\"{}\"", esc(value)))
        .unwrap_or_default();
    let body_size = (styles.font_size_pt * 2.0).round() as i64;
    let heading_color = parse_color(&styles.heading_color)
        .map(|color| color.0)
        .unwrap_or_else(|_| "1F3864".to_string());
    let text_color = styles
        .text_color
        .as_deref()
        .and_then(|value| parse_color(value).ok())
        .map(|color| format!("<w:color w:val=\"{}\"/>", color.0))
        .unwrap_or_default();
    let line = (styles.line_spacing * 240.0).round() as i64;
    let after = pt_twips(styles.paragraph_space_after_pt);

    let mut out = String::from(XML_HEADER);
    out.push_str(
        "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    );
    out.push_str(&format!(
        "<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"{font}\" w:hAnsi=\"{font}\" w:cs=\"{font}\"{east_asia}/>{text_color}<w:sz w:val=\"{body_size}\"/><w:szCs w:val=\"{body_size}\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"{after}\" w:line=\"{line}\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>"
    ));
    out.push_str("<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>");
    out.push_str("<w:style w:type=\"character\" w:default=\"1\" w:styleId=\"DefaultParagraphFont\"><w:name w:val=\"Default Paragraph Font\"/><w:uiPriority w:val=\"1\"/><w:semiHidden/><w:unhideWhenUsed/></w:style>");
    out.push_str("<w:style w:type=\"table\" w:default=\"1\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/><w:uiPriority w:val=\"99\"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"108\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>");
    out.push_str("<w:style w:type=\"numbering\" w:default=\"1\" w:styleId=\"NoList\"><w:name w:val=\"No List\"/><w:uiPriority w:val=\"99\"/><w:semiHidden/><w:unhideWhenUsed/></w:style>");
    let heading_sizes: [f64; 6] = [18.0, 15.0, 13.0, 12.0, 11.0, 11.0];
    let spacing_before = [360, 240, 200, 160, 120, 120];
    for level in 1..=6usize {
        let size = (heading_sizes[level - 1].max(styles.font_size_pt) * 2.0).round() as i64;
        let italic = if level >= 5 { "<w:i/><w:iCs/>" } else { "" };
        out.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{level}\"><w:name w:val=\"heading {level}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"{}\" w:after=\"120\"/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"{heading_font}\" w:hAnsi=\"{heading_font}\" w:cs=\"{heading_font}\"/><w:b/><w:bCs/>{italic}<w:color w:val=\"{heading_color}\"/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>",
            spacing_before[level - 1],
            level - 1
        ));
    }
    out.push_str(&format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"10\"/><w:qFormat/><w:pPr><w:spacing w:after=\"160\" w:line=\"240\" w:lineRule=\"auto\"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:ascii=\"{heading_font}\" w:hAnsi=\"{heading_font}\" w:cs=\"{heading_font}\"/><w:b/><w:color w:val=\"{heading_color}\"/><w:kern w:val=\"28\"/><w:sz w:val=\"52\"/><w:szCs w:val=\"52\"/></w:rPr></w:style>"
    ));
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Subtitle\"><w:name w:val=\"Subtitle\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"11\"/><w:qFormat/><w:pPr><w:spacing w:after=\"240\"/></w:pPr><w:rPr><w:color w:val=\"595959\"/><w:sz w:val=\"30\"/><w:szCs w:val=\"30\"/></w:rPr></w:style>");
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Caption\"><w:name w:val=\"caption\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"35\"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:spacing w:after=\"200\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val=\"595959\"/><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>");
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"29\"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val=\"single\" w:sz=\"18\" w:space=\"8\" w:color=\"BFBFBF\"/></w:pBdr><w:spacing w:before=\"120\" w:after=\"120\"/><w:ind w:left=\"567\" w:right=\"567\"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val=\"404040\"/></w:rPr></w:style>");
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"39\"/><w:qFormat/><w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/><w:spacing w:before=\"120\" w:after=\"120\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/><w:sz w:val=\"19\"/><w:szCs w:val=\"19\"/></w:rPr></w:style>");
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"34\"/><w:qFormat/><w:pPr><w:spacing w:after=\"60\"/><w:ind w:left=\"720\"/><w:contextualSpacing/></w:pPr></w:style>");
    out.push_str(&format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"TOCHeading\"><w:name w:val=\"TOC Heading\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"39\"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"{heading_font}\" w:hAnsi=\"{heading_font}\" w:cs=\"{heading_font}\"/><w:b/><w:color w:val=\"{heading_color}\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:style>"
    ));
    for level in 1..=6u32 {
        out.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"TOC{level}\"><w:name w:val=\"toc {level}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"39\"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after=\"60\"/><w:ind w:left=\"{}\"/></w:pPr></w:style>",
            (level - 1) * 220
        ));
    }
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Header\"><w:name w:val=\"header\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:color w:val=\"7F7F7F\"/><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>");
    out.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Footer\"><w:name w:val=\"footer\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:color w:val=\"7F7F7F\"/><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>");
    out.push_str("<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:basedOn w:val=\"DefaultParagraphFont\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>");
    out.push_str("</w:styles>");
    out
}
