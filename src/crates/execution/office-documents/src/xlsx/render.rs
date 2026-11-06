//! SpreadsheetML package writer.

use super::address::{column_letters, parse_range, CellRef};
use super::eval::{evaluate_workbook, Computed};
use super::model::{
    BorderStyle, Cell, CellStyle, HorizontalAlign, Sheet, VerticalAlignment, XlsxDocument,
};
use crate::common::parse_color;
use crate::error::OfficeResult;
use crate::package::{add_common_parts, ContentTypes, Parts, Relationships};
use crate::xml::{esc, needs_preserve, XML_HEADER};
use serde_json::Value;
use std::collections::HashMap;

const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_WORKSHEET: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const REL_STYLES: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
const REL_SHARED_STRINGS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";

pub(crate) fn render(
    book: &XlsxDocument,
    created: Option<&str>,
    modified: Option<&str>,
) -> OfficeResult<Parts> {
    let placeholder;
    let sheets: &[Sheet] = if book.sheets.is_empty() {
        placeholder = [Sheet {
            name: "Sheet1".to_string(),
            ..Sheet::default()
        }];
        &placeholder
    } else {
        &book.sheets
    };

    let computed = evaluate_workbook(book);
    let mut styles = StyleRegistry::new();
    let mut strings = SharedStrings::default();
    let mut parts = Parts::default();
    let mut types = ContentTypes::new();
    let mut rels = Relationships::default();
    let mut workbook_sheets = String::new();
    let mut defined_names = String::new();

    for (index, sheet) in sheets.iter().enumerate() {
        let number = index + 1;
        let part = format!("xl/worksheets/sheet{number}.xml");
        let rel = rels.add(REL_WORKSHEET, &format!("worksheets/sheet{number}.xml"));
        workbook_sheets.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{number}\" r:id=\"{rel}\"/>",
            esc(&sheet.name)
        ));
        if let Some(range) = sheet
            .autofilter
            .as_deref()
            .and_then(|range| parse_range(range).ok())
        {
            defined_names.push_str(&format!(
                "<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"{index}\" hidden=\"1\">{}!{}</definedName>",
                esc(&super::formula::quote_sheet_name(&sheet.name)),
                absolute(&range.start, &range.end)
            ));
        }
        types.part(
            &part,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        );
        let drawing =
            super::chart_render::render(book, sheet, number, &computed, &mut parts, &mut types)?;
        parts.add_xml(
            part,
            worksheet_xml(
                sheet,
                index,
                &computed,
                &mut styles,
                &mut strings,
                drawing.as_deref(),
            ),
        );
    }
    rels.add(REL_STYLES, "styles.xml");
    rels.add(REL_SHARED_STRINGS, "sharedStrings.xml");

    let mut workbook = format!(
        "{XML_HEADER}<workbook xmlns=\"{NS_MAIN}\" xmlns:r=\"{NS_REL}\"><workbookPr/><bookViews><workbookView activeTab=\"0\"/></bookViews><sheets>{workbook_sheets}</sheets>"
    );
    if !defined_names.is_empty() {
        workbook.push_str(&format!("<definedNames>{defined_names}</definedNames>"));
    }
    workbook.push_str("<calcPr calcId=\"191029\" fullCalcOnLoad=\"1\"/></workbook>");

    types.part(
        "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    );
    types.part(
        "xl/styles.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    );
    types.part(
        "xl/sharedStrings.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    );
    parts.add_xml("xl/workbook.xml", workbook);
    parts.add_xml("xl/_rels/workbook.xml.rels", rels.xml());
    parts.add_xml("xl/styles.xml", styles.xml());
    parts.add_xml("xl/sharedStrings.xml", strings.xml());
    add_common_parts(
        &mut parts,
        &mut types,
        "xl/workbook.xml",
        &book.properties,
        created,
        modified,
        "OpenBitFun GenOfficeFile",
    );
    parts.add_xml("[Content_Types].xml", types.xml());
    Ok(parts)
}

fn absolute(start: &CellRef, end: &CellRef) -> String {
    format!(
        "${}${}:${}${}",
        column_letters(start.col),
        start.row,
        column_letters(end.col),
        end.row
    )
}

fn worksheet_xml(
    sheet: &Sheet,
    sheet_index: usize,
    computed: &HashMap<(usize, CellRef), Computed>,
    styles: &mut StyleRegistry,
    strings: &mut SharedStrings,
    drawing: Option<&str>,
) -> String {
    let selected = sheet_index == 0;
    let mut xml = format!("{XML_HEADER}<worksheet xmlns=\"{NS_MAIN}\" xmlns:r=\"{NS_REL}\">");
    if let Some((rgb, _)) = sheet
        .tab_color
        .as_deref()
        .and_then(|color| parse_color(color).ok())
    {
        xml.push_str(&format!("<sheetPr><tabColor rgb=\"FF{rgb}\"/></sheetPr>"));
    }
    let dimension = match (sheet.cells.keys().next(), sheet.cells.keys().last()) {
        (Some(_), Some(_)) => {
            let min_col = sheet.cells.keys().map(|cell| cell.col).min().unwrap_or(1);
            let max_col = sheet.cells.keys().map(|cell| cell.col).max().unwrap_or(1);
            let min_row = sheet.cells.keys().map(|cell| cell.row).min().unwrap_or(1);
            let max_row = sheet.cells.keys().map(|cell| cell.row).max().unwrap_or(1);
            let start = CellRef::new(min_row, min_col);
            let end = CellRef::new(max_row, max_col);
            if start == end {
                start.to_string()
            } else {
                format!("{start}:{end}")
            }
        }
        _ => "A1".to_string(),
    };
    xml.push_str(&format!("<dimension ref=\"{dimension}\"/>"));
    xml.push_str(&format!(
        "<sheetViews><sheetView workbookViewId=\"0\"{}>",
        if selected { " tabSelected=\"1\"" } else { "" }
    ));
    if let Some(freeze) = sheet
        .freeze
        .filter(|freeze| freeze.rows > 0 || freeze.columns > 0)
    {
        let top_left = CellRef::new(freeze.rows + 1, freeze.columns + 1);
        let pane = match (freeze.rows > 0, freeze.columns > 0) {
            (true, true) => "bottomRight",
            (true, false) => "bottomLeft",
            _ => "topRight",
        };
        xml.push_str("<pane");
        if freeze.columns > 0 {
            xml.push_str(&format!(" xSplit=\"{}\"", freeze.columns));
        }
        if freeze.rows > 0 {
            xml.push_str(&format!(" ySplit=\"{}\"", freeze.rows));
        }
        xml.push_str(&format!(
            " topLeftCell=\"{top_left}\" activePane=\"{pane}\" state=\"frozen\"/><selection pane=\"{pane}\" activeCell=\"{top_left}\" sqref=\"{top_left}\"/>"
        ));
    }
    xml.push_str("</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/>");
    if !sheet.column_widths.is_empty() {
        xml.push_str("<cols>");
        for (column, width) in &sheet.column_widths {
            xml.push_str(&format!(
                "<col min=\"{column}\" max=\"{column}\" width=\"{}\" customWidth=\"1\"{}/>",
                number(*width),
                if *width == 0.0 { " hidden=\"1\"" } else { "" }
            ));
        }
        xml.push_str("</cols>");
    }
    xml.push_str("<sheetData>");
    let mut rows: Vec<u32> = sheet.cells.keys().map(|cell| cell.row).collect();
    rows.extend(sheet.row_heights.keys().copied());
    rows.sort_unstable();
    rows.dedup();
    let mut cells = sheet.cells.iter().peekable();
    for row in rows {
        xml.push_str(&format!("<row r=\"{row}\""));
        if let Some(height) = sheet.row_heights.get(&row) {
            xml.push_str(&format!(" ht=\"{}\" customHeight=\"1\"", number(*height)));
            if *height == 0.0 {
                xml.push_str(" hidden=\"1\"");
            }
        }
        xml.push('>');
        while let Some((address, cell)) = cells.peek() {
            if address.row != row {
                break;
            }
            xml.push_str(&cell_xml(
                address,
                cell,
                computed.get(&(sheet_index, **address)),
                styles,
                strings,
            ));
            cells.next();
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData>");
    if let Some(range) = sheet
        .autofilter
        .as_deref()
        .and_then(|range| parse_range(range).ok())
    {
        xml.push_str(&format!("<autoFilter ref=\"{range}\"/>"));
    }
    let merges: Vec<String> = sheet
        .merges
        .iter()
        .filter_map(|merge| parse_range(merge).ok())
        .map(|range| range.to_string())
        .collect();
    if !merges.is_empty() {
        xml.push_str(&format!("<mergeCells count=\"{}\">", merges.len()));
        for merge in merges {
            xml.push_str(&format!("<mergeCell ref=\"{merge}\"/>"));
        }
        xml.push_str("</mergeCells>");
    }
    xml.push_str("<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>");
    if let Some(id) = drawing {
        xml.push_str(&format!("<drawing r:id=\"{id}\"/>"));
    }
    xml.push_str("</worksheet>");
    xml
}

fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn cell_xml(
    address: &CellRef,
    cell: &Cell,
    computed: Option<&Computed>,
    styles: &mut StyleRegistry,
    strings: &mut SharedStrings,
) -> String {
    let style = cell
        .style
        .as_ref()
        .map(|style| styles.xf(style))
        .unwrap_or(0);
    let style_attr = if style > 0 {
        format!(" s=\"{style}\"")
    } else {
        String::new()
    };
    if let Some(formula) = &cell.formula {
        // Cached results let viewers that do not recalculate show values;
        // Excel recomputes everything on open (fullCalcOnLoad).
        let f = format!("<f>{}</f>", esc(formula));
        return match computed {
            Some(Computed::Number(value)) => format!(
                "<c r=\"{address}\"{style_attr}>{f}<v>{}</v></c>",
                number(*value)
            ),
            Some(Computed::Empty) => format!("<c r=\"{address}\"{style_attr}>{f}<v>0</v></c>"),
            Some(Computed::Text(text)) => format!(
                "<c r=\"{address}\"{style_attr} t=\"str\">{f}<v>{}</v></c>",
                esc(text)
            ),
            Some(Computed::Bool(value)) => format!(
                "<c r=\"{address}\"{style_attr} t=\"b\">{f}<v>{}</v></c>",
                u8::from(*value)
            ),
            Some(Computed::Error(error)) => format!(
                "<c r=\"{address}\"{style_attr} t=\"e\">{f}<v>{}</v></c>",
                esc(error)
            ),
            None => format!("<c r=\"{address}\"{style_attr}>{f}</c>"),
        };
    }
    match &cell.value {
        Value::Number(value) => format!(
            "<c r=\"{address}\"{style_attr}><v>{}</v></c>",
            value
                .as_f64()
                .map(number)
                .unwrap_or_else(|| value.to_string())
        ),
        Value::Bool(value) => format!(
            "<c r=\"{address}\"{style_attr} t=\"b\"><v>{}</v></c>",
            u8::from(*value)
        ),
        Value::String(text) => {
            let index = strings.index(text);
            format!("<c r=\"{address}\"{style_attr} t=\"s\"><v>{index}</v></c>")
        }
        _ => format!("<c r=\"{address}\"{style_attr}/>"),
    }
}

#[derive(Default)]
struct SharedStrings {
    list: Vec<String>,
    map: HashMap<String, usize>,
    count: usize,
}

impl SharedStrings {
    fn index(&mut self, text: &str) -> usize {
        self.count += 1;
        if let Some(index) = self.map.get(text) {
            return *index;
        }
        let index = self.list.len();
        self.list.push(text.to_string());
        self.map.insert(text.to_string(), index);
        index
    }

    fn xml(&self) -> String {
        let mut xml = format!(
            "{XML_HEADER}<sst xmlns=\"{NS_MAIN}\" count=\"{}\" uniqueCount=\"{}\">",
            self.count,
            self.list.len()
        );
        for text in &self.list {
            if needs_preserve(text) || text.contains('\n') {
                xml.push_str(&format!(
                    "<si><t xml:space=\"preserve\">{}</t></si>",
                    esc(text)
                ));
            } else {
                xml.push_str(&format!("<si><t>{}</t></si>", esc(text)));
            }
        }
        xml.push_str("</sst>");
        xml
    }
}

/// Deduplicating registry of fonts, fills, borders, number formats, and
/// cell formats (`cellXfs`).
struct StyleRegistry {
    fonts: Vec<String>,
    fills: Vec<String>,
    borders: Vec<String>,
    num_fmts: Vec<(u32, String)>,
    xfs: Vec<String>,
    xf_index: HashMap<String, u32>,
}

impl StyleRegistry {
    fn new() -> Self {
        Self {
            fonts: vec![
                "<font><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font>"
                    .to_string(),
            ],
            fills: vec![
                "<fill><patternFill patternType=\"none\"/></fill>".to_string(),
                "<fill><patternFill patternType=\"gray125\"/></fill>".to_string(),
            ],
            borders: vec!["<border><left/><right/><top/><bottom/><diagonal/></border>".to_string()],
            num_fmts: Vec::new(),
            xfs: vec![
                "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
                    .to_string(),
            ],
            xf_index: HashMap::new(),
        }
    }

    fn intern(list: &mut Vec<String>, xml: String) -> usize {
        if let Some(index) = list.iter().position(|existing| *existing == xml) {
            return index;
        }
        list.push(xml);
        list.len() - 1
    }

    fn number_format(&mut self, code: &str) -> u32 {
        let builtin = match code {
            "General" | "general" => Some(0),
            "0" => Some(1),
            "0.00" => Some(2),
            "#,##0" => Some(3),
            "#,##0.00" => Some(4),
            "0%" => Some(9),
            "0.00%" => Some(10),
            "0.00E+00" => Some(11),
            "@" => Some(49),
            _ => None,
        };
        if let Some(id) = builtin {
            return id;
        }
        if let Some((id, _)) = self.num_fmts.iter().find(|(_, existing)| existing == code) {
            return *id;
        }
        let id = 164 + self.num_fmts.len() as u32;
        self.num_fmts.push((id, code.to_string()));
        id
    }

    fn xf(&mut self, style: &CellStyle) -> u32 {
        let font = {
            let mut xml = String::from("<font>");
            if style.bold == Some(true) {
                xml.push_str("<b/>");
            }
            if style.italic == Some(true) {
                xml.push_str("<i/>");
            }
            if style.strike == Some(true) {
                xml.push_str("<strike/>");
            }
            if style.underline == Some(true) {
                xml.push_str("<u/>");
            }
            xml.push_str(&format!(
                "<sz val=\"{}\"/>",
                number(style.font_size.unwrap_or(11.0))
            ));
            if let Some((rgb, _)) = style
                .font_color
                .as_deref()
                .and_then(|color| parse_color(color).ok())
            {
                xml.push_str(&format!("<color rgb=\"FF{rgb}\"/>"));
            }
            xml.push_str(&format!(
                "<name val=\"{}\"/><family val=\"2\"/></font>",
                esc(style.font_name.as_deref().unwrap_or("Calibri"))
            ));
            Self::intern(&mut self.fonts, xml)
        };
        let fill = match style.fill_color.as_deref().and_then(|color| parse_color(color).ok()) {
            Some((rgb, _)) => Self::intern(
                &mut self.fills,
                format!("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{rgb}\"/><bgColor indexed=\"64\"/></patternFill></fill>"),
            ),
            None => 0,
        };
        let border = match style.border.filter(|border| *border != BorderStyle::None) {
            Some(border) => {
                let kind = match border {
                    BorderStyle::Thin => "thin",
                    BorderStyle::Medium => "medium",
                    BorderStyle::Thick => "thick",
                    BorderStyle::Dashed => "dashed",
                    BorderStyle::Dotted => "dotted",
                    BorderStyle::Double => "double",
                    BorderStyle::None => "none",
                };
                let color = style
                    .border_color
                    .as_deref()
                    .and_then(|color| parse_color(color).ok())
                    .map(|(rgb, _)| format!("<color rgb=\"FF{rgb}\"/>"))
                    .unwrap_or_else(|| "<color auto=\"1\"/>".to_string());
                let side = |name: &str| format!("<{name} style=\"{kind}\">{color}</{name}>");
                Self::intern(
                    &mut self.borders,
                    format!(
                        "<border>{}{}{}{}<diagonal/></border>",
                        side("left"),
                        side("right"),
                        side("top"),
                        side("bottom")
                    ),
                )
            }
            None => 0,
        };
        let num_fmt = style
            .number_format
            .as_deref()
            .map(|code| self.number_format(code))
            .unwrap_or(0);
        let mut alignment = String::new();
        if let Some(align) = style.align {
            let value = match align {
                HorizontalAlign::General => "general",
                HorizontalAlign::Left => "left",
                HorizontalAlign::Center => "center",
                HorizontalAlign::Right => "right",
                HorizontalAlign::Justify => "justify",
            };
            alignment.push_str(&format!(" horizontal=\"{value}\""));
        }
        if let Some(valign) = style.valign {
            let value = match valign {
                VerticalAlignment::Top => "top",
                VerticalAlignment::Center => "center",
                VerticalAlignment::Bottom => "bottom",
            };
            alignment.push_str(&format!(" vertical=\"{value}\""));
        }
        if style.wrap == Some(true) {
            alignment.push_str(" wrapText=\"1\"");
        }
        if let Some(indent) = style.indent.filter(|indent| *indent > 0) {
            alignment.push_str(&format!(" indent=\"{indent}\""));
        }
        let mut xf = format!(
            "<xf numFmtId=\"{num_fmt}\" fontId=\"{font}\" fillId=\"{fill}\" borderId=\"{border}\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyFill=\"1\" applyBorder=\"1\""
        );
        if alignment.is_empty() {
            xf.push_str("/>");
        } else {
            xf.push_str(&format!(
                " applyAlignment=\"1\"><alignment{alignment}/></xf>"
            ));
        }
        if let Some(index) = self.xf_index.get(&xf) {
            return *index;
        }
        let index = self.xfs.len() as u32;
        self.xfs.push(xf.clone());
        self.xf_index.insert(xf, index);
        index
    }

    fn xml(&self) -> String {
        let mut xml = format!("{XML_HEADER}<styleSheet xmlns=\"{NS_MAIN}\">");
        if !self.num_fmts.is_empty() {
            xml.push_str(&format!("<numFmts count=\"{}\">", self.num_fmts.len()));
            for (id, code) in &self.num_fmts {
                xml.push_str(&format!(
                    "<numFmt numFmtId=\"{id}\" formatCode=\"{}\"/>",
                    esc(code)
                ));
            }
            xml.push_str("</numFmts>");
        }
        let section = |tag: &str, items: &[String]| {
            format!(
                "<{tag} count=\"{}\">{}</{tag}>",
                items.len(),
                items.concat()
            )
        };
        xml.push_str(&section("fonts", &self.fonts));
        xml.push_str(&section("fills", &self.fills));
        xml.push_str(&section("borders", &self.borders));
        xml.push_str("<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>");
        xml.push_str(&section("cellXfs", &self.xfs));
        xml.push_str("<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles><dxfs count=\"0\"/><tableStyles count=\"0\" defaultTableStyle=\"TableStyleMedium2\" defaultPivotStyle=\"PivotStyleLight16\"/></styleSheet>");
        xml
    }
}
