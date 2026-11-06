//! DrawingML parts and reference caches for native spreadsheet charts.

use super::address::{column_letters, parse_cell, CellRef};
use super::charts::{Chart, ChartKind, ChartRange};
use super::eval::Computed;
use super::model::{Sheet, XlsxDocument};
use crate::common::parse_color;
use crate::package::{ContentTypes, Parts, Relationships};
use crate::xml::{esc, XML_HEADER};
use crate::OfficeResult;
use serde_json::Value;
use std::collections::HashMap;

const DRAWING: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CHART: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SHEET_DRAWING: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

/// Returns the worksheet drawing relationship, if any.
pub(super) fn render(
    book: &XlsxDocument,
    sheet: &Sheet,
    number: usize,
    computed: &HashMap<(usize, CellRef), Computed>,
    parts: &mut Parts,
    types: &mut ContentTypes,
) -> OfficeResult<Option<String>> {
    if sheet.charts.is_empty() {
        return Ok(None);
    }
    let mut worksheet_rels = Relationships::default();
    let id = worksheet_rels.add(
        &format!("{REL}/drawing"),
        &format!("../drawings/drawing{number}.xml"),
    );
    parts.add_xml(
        format!("xl/worksheets/_rels/sheet{number}.xml.rels"),
        worksheet_rels.xml(),
    );
    let mut drawing_rels = Relationships::default();
    let mut xml =
        format!("{XML_HEADER}<xdr:wsDr xmlns:xdr=\"{SHEET_DRAWING}\" xmlns:a=\"{DRAWING}\">");
    for (index, chart) in sheet.charts.iter().enumerate() {
        let name = format!("chart{number}_{}.xml", index + 1);
        let rel = drawing_rels.add(&format!("{REL}/chart"), &format!("../charts/{name}"));
        let part = format!("xl/charts/{name}");
        types.part(
            &part,
            "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
        );
        parts.add_xml(part, chart_xml(book, sheet, chart, computed));
        let anchor = parse_cell(&chart.anchor)?;
        let (col, row) = (anchor.col - 1, anchor.row - 1);
        let (cx, cy) = (chart.width_px as u64 * 9525, chart.height_px as u64 * 9525);
        let id = index + 1;
        xml.push_str(&format!(
            "<xdr:oneCellAnchor><xdr:from><xdr:col>{col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx=\"{cx}\" cy=\"{cy}\"/><xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{id}\" name=\"Chart {id}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></xdr:xfrm><a:graphic><a:graphicData uri=\"{CHART}\"><c:chart xmlns:c=\"{CHART}\" xmlns:r=\"{REL}\" r:id=\"{rel}\"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>"
        ));
    }
    xml.push_str("</xdr:wsDr>");
    let part = format!("xl/drawings/drawing{number}.xml");
    types.part(
        &part,
        "application/vnd.openxmlformats-officedocument.drawing+xml",
    );
    parts.add_xml(part, xml);
    parts.add_xml(
        format!("xl/drawings/_rels/drawing{number}.xml.rels"),
        drawing_rels.xml(),
    );
    Ok(Some(id))
}

fn chart_xml(
    book: &XlsxDocument,
    owner: &Sheet,
    chart: &Chart,
    computed: &HashMap<(usize, CellRef), Computed>,
) -> String {
    let mut xml = format!("{XML_HEADER}<c:chartSpace xmlns:c=\"{CHART}\" xmlns:a=\"{DRAWING}\" xmlns:r=\"{REL}\"><c:chart>");
    if let Some(title) = &chart.title {
        xml.push_str(&format!("<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title>", esc(title)));
    } else {
        xml.push_str("<c:autoTitleDeleted val=\"1\"/>");
    }
    xml.push_str("<c:plotArea><c:layout/>");
    let tag = match chart.kind {
        ChartKind::Column | ChartKind::Bar => "barChart",
        ChartKind::Line => "lineChart",
        ChartKind::Pie => "pieChart",
    };
    xml.push_str(&format!("<c:{tag}>"));
    match chart.kind {
        ChartKind::Column | ChartKind::Bar => xml.push_str(&format!(
            "<c:barDir val=\"{}\"/><c:grouping val=\"clustered\"/>",
            if chart.kind == ChartKind::Column {
                "col"
            } else {
                "bar"
            }
        )),
        ChartKind::Line => xml.push_str("<c:grouping val=\"standard\"/>"),
        ChartKind::Pie => {}
    }
    xml.push_str(&format!(
        "<c:varyColors val=\"{}\"/>",
        u8::from(chart.kind == ChartKind::Pie)
    ));
    for (index, series) in chart.series.iter().enumerate() {
        xml.push_str(&format!(
            "<c:ser><c:idx val=\"{index}\"/><c:order val=\"{index}\"/>"
        ));
        if let Some(name) = &series.name {
            xml.push_str(&format!("<c:tx><c:v>{}</c:v></c:tx>", esc(name)));
        }
        if let Some((color, _)) = series
            .color
            .as_deref()
            .and_then(|color| parse_color(color).ok())
        {
            let fill = format!("<a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill>");
            let style = if chart.kind == ChartKind::Line {
                format!("<a:ln>{fill}</a:ln>")
            } else {
                fill
            };
            xml.push_str(&format!("<c:spPr>{style}</c:spPr>"));
        }
        xml.push_str("<c:cat>");
        xml.push_str(&reference_xml(
            book,
            &owner.name,
            &series.categories,
            computed,
            false,
        ));
        xml.push_str("</c:cat><c:val>");
        xml.push_str(&reference_xml(
            book,
            &owner.name,
            &series.values,
            computed,
            true,
        ));
        xml.push_str("</c:val></c:ser>");
    }
    if chart.kind == ChartKind::Line {
        xml.push_str("<c:marker val=\"1\"/><c:smooth val=\"0\"/>");
    }
    if chart.kind != ChartKind::Pie {
        xml.push_str("<c:axId val=\"1\"/><c:axId val=\"2\"/>");
    }
    xml.push_str(&format!("</c:{tag}>"));
    if chart.kind != ChartKind::Pie {
        let (category, value) = if chart.kind == ChartKind::Bar {
            ("l", "b")
        } else {
            ("b", "l")
        };
        xml.push_str(&format!("<c:catAx><c:axId val=\"1\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"{category}\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"2\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/></c:catAx><c:valAx><c:axId val=\"2\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"{value}\"/><c:majorGridlines/><c:numFmt formatCode=\"General\" sourceLinked=\"1\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"1\"/><c:crosses val=\"autoZero\"/><c:crossBetween val=\"between\"/></c:valAx>"));
    }
    xml.push_str("</c:plotArea>");
    if chart.legend {
        xml.push_str("<c:legend><c:legendPos val=\"b\"/><c:overlay val=\"0\"/></c:legend>");
    }
    xml.push_str(
        "<c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart></c:chartSpace>",
    );
    xml
}

fn reference_xml(
    book: &XlsxDocument,
    owner: &str,
    source: &ChartRange,
    computed: &HashMap<(usize, CellRef), Computed>,
    numeric: bool,
) -> String {
    let sheet_name = source.sheet.as_deref().unwrap_or(owner);
    let sheet_index = book.sheet_index(sheet_name);
    let range = source.vector().ok();
    let formula = match (&range, sheet_index) {
        (Some(range), Some(_)) => format!(
            "{}!${}${}:${}${}",
            super::formula::quote_sheet_name(sheet_name),
            column_letters(range.start.col),
            range.start.row,
            column_letters(range.end.col),
            range.end.row
        ),
        _ => "#REF!".to_string(),
    };
    let (tag, cache) = if numeric {
        ("numRef", "numCache")
    } else {
        ("strRef", "strCache")
    };
    let mut xml = format!("<c:{tag}><c:f>{}</c:f><c:{cache}>", esc(&formula));
    if numeric {
        xml.push_str("<c:formatCode>General</c:formatCode>");
    }
    let count = range.as_ref().map(|range| range.cell_count()).unwrap_or(0);
    xml.push_str(&format!("<c:ptCount val=\"{count}\"/>"));
    if let (Some(range), Some(index)) = (range, sheet_index) {
        for offset in 0..count as u32 {
            let address = if range.start.row == range.end.row {
                CellRef::new(range.start.row, range.start.col + offset)
            } else {
                CellRef::new(range.start.row + offset, range.start.col)
            };
            let Some(cell) = book.sheets[index].cells.get(&address) else {
                continue;
            };
            let value = if cell.formula.is_some() {
                match computed.get(&(index, address)) {
                    Some(Computed::Number(n)) => Some(n.to_string()),
                    Some(Computed::Text(s)) if !numeric => Some(s.clone()),
                    Some(Computed::Bool(b)) if !numeric => Some(b.to_string()),
                    _ => None,
                }
            } else {
                match &cell.value {
                    Value::Number(n) => Some(n.to_string()),
                    Value::String(s) if !numeric => Some(s.clone()),
                    Value::Bool(b) if !numeric => Some(b.to_string()),
                    _ => None,
                }
            };
            if let Some(value) = value {
                xml.push_str(&format!(
                    "<c:pt idx=\"{offset}\"><c:v>{}</c:v></c:pt>",
                    esc(&value)
                ));
            }
        }
    }
    xml.push_str(&format!("</c:{cache}></c:{tag}>"));
    xml
}
