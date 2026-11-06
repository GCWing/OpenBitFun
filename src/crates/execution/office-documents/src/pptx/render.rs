//! PresentationML package writer.

use super::model::{
    Element, ImageElement, ImageFit, Paragraph, PptxDocument, ShapeElement, Slide, SlideSize,
    TableElement, TextDefaults, TextElement,
};
use crate::common::{parse_color, Align, Run, VerticalAlign};
use crate::error::{OfficeError, OfficeResult};
use crate::image::{kind_of_asset, sniff};
use crate::package::{add_common_parts, ContentTypes, Parts, Relationships};
use crate::xml::{esc, XML_HEADER};
use std::collections::BTreeMap;

const NS: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const EMU_PER_PX: f64 = 9525.0;
const EMU_PER_PT: f64 = 12700.0;
const GROUP_HEADER: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";
const CLR_MAP: &str = "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>";

fn rel(kind: &str) -> String {
    format!("{REL_BASE}{kind}")
}

fn emu(px: f64) -> i64 {
    (px * EMU_PER_PX).round() as i64
}

pub(crate) fn render(
    deck: &PptxDocument,
    assets: &BTreeMap<String, Vec<u8>>,
    created: Option<&str>,
    modified: Option<&str>,
) -> OfficeResult<Parts> {
    let mut parts = Parts::default();
    let mut types = ContentTypes::new();
    let mut presentation_rels = Relationships::default();
    let (slide_cx, slide_cy) = slide_emu(deck.slide_size);
    let has_notes = deck.slides.iter().any(|slide| {
        slide
            .notes
            .as_deref()
            .is_some_and(|notes| !notes.is_empty())
    });

    let master_rel = presentation_rels.add(&rel("slideMaster"), "slideMasters/slideMaster1.xml");
    let mut slide_ids = String::new();
    let mut used_assets: Vec<String> = Vec::new();
    for (index, slide) in deck.slides.iter().enumerate() {
        let number = index + 1;
        let id = presentation_rels.add(&rel("slide"), &format!("slides/slide{number}.xml"));
        slide_ids.push_str(&format!("<p:sldId id=\"{}\" r:id=\"{id}\"/>", 256 + index));
        let mut slide_rels = Relationships::default();
        slide_rels.add(&rel("slideLayout"), "../slideLayouts/slideLayout1.xml");
        let body = SlideWriter {
            deck,
            assets,
            rels: &mut slide_rels,
            used_assets: &mut used_assets,
            image_rels: BTreeMap::new(),
            link_rels: BTreeMap::new(),
            next_id: 2,
        }
        .slide(slide)?;
        if slide
            .notes
            .as_deref()
            .is_some_and(|notes| !notes.is_empty())
        {
            slide_rels.add(
                &rel("notesSlide"),
                &format!("../notesSlides/notesSlide{number}.xml"),
            );
            let mut notes_rels = Relationships::default();
            notes_rels.add(&rel("notesMaster"), "../notesMasters/notesMaster1.xml");
            notes_rels.add(&rel("slide"), &format!("../slides/slide{number}.xml"));
            parts.add_xml(
                format!("ppt/notesSlides/notesSlide{number}.xml"),
                notes_xml(slide.notes.as_deref().unwrap_or("")),
            );
            parts.add_xml(
                format!("ppt/notesSlides/_rels/notesSlide{number}.xml.rels"),
                notes_rels.xml(),
            );
            types.part(
                &format!("ppt/notesSlides/notesSlide{number}.xml"),
                "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
            );
        }
        parts.add_xml(format!("ppt/slides/slide{number}.xml"), body);
        parts.add_xml(
            format!("ppt/slides/_rels/slide{number}.xml.rels"),
            slide_rels.xml(),
        );
        types.part(
            &format!("ppt/slides/slide{number}.xml"),
            "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
        );
    }
    let notes_master_rel = has_notes
        .then(|| presentation_rels.add(&rel("notesMaster"), "notesMasters/notesMaster1.xml"));
    presentation_rels.add(&rel("presProps"), "presProps.xml");
    presentation_rels.add(&rel("viewProps"), "viewProps.xml");
    presentation_rels.add(&rel("theme"), "theme/theme1.xml");
    presentation_rels.add(&rel("tableStyles"), "tableStyles.xml");

    let mut presentation = format!("{XML_HEADER}<p:presentation {NS} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"{master_rel}\"/></p:sldMasterIdLst>");
    if let Some(id) = &notes_master_rel {
        presentation.push_str(&format!(
            "<p:notesMasterIdLst><p:notesMasterId r:id=\"{id}\"/></p:notesMasterIdLst>"
        ));
    }
    if !slide_ids.is_empty() {
        presentation.push_str(&format!("<p:sldIdLst>{slide_ids}</p:sldIdLst>"));
    }
    let size_type = match deck.slide_size {
        SlideSize::Wide => "",
        SlideSize::Standard => " type=\"screen4x3\"",
    };
    presentation.push_str(&format!("<p:sldSz cx=\"{slide_cx}\" cy=\"{slide_cy}\"{size_type}/><p:notesSz cx=\"6858000\" cy=\"9144000\"/>"));
    presentation.push_str(&format!("<p:defaultTextStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr>{}</p:defaultTextStyle></p:presentation>", level_styles(1800)));

    parts.add_xml("ppt/presentation.xml", presentation);
    parts.add_xml("ppt/_rels/presentation.xml.rels", presentation_rels.xml());
    parts.add_xml(
        "ppt/presProps.xml",
        format!("{XML_HEADER}<p:presentationPr {NS}/>"),
    );
    parts.add_xml("ppt/viewProps.xml", format!("{XML_HEADER}<p:viewPr {NS}><p:normalViewPr><p:restoredLeft sz=\"15620\"/><p:restoredTop sz=\"94660\"/></p:normalViewPr><p:gridSpacing cx=\"76200\" cy=\"76200\"/></p:viewPr>"));
    parts.add_xml("ppt/tableStyles.xml", format!("{XML_HEADER}<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"{{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}}\"/>"));
    parts.add_xml("ppt/theme/theme1.xml", theme_xml(deck));
    parts.add_xml("ppt/slideMasters/slideMaster1.xml", master_xml());
    let mut master_rels = Relationships::default();
    master_rels.add(&rel("slideLayout"), "../slideLayouts/slideLayout1.xml");
    master_rels.add(&rel("theme"), "../theme/theme1.xml");
    parts.add_xml(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        master_rels.xml(),
    );
    parts.add_xml("ppt/slideLayouts/slideLayout1.xml", format!("{XML_HEADER}<p:sldLayout {NS} preserve=\"1\" type=\"blank\"><p:cSld name=\"Blank\"><p:spTree>{GROUP_HEADER}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"));
    let mut layout_rels = Relationships::default();
    layout_rels.add(&rel("slideMaster"), "../slideMasters/slideMaster1.xml");
    parts.add_xml(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        layout_rels.xml(),
    );

    types.part(
        "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    );
    types.part(
        "ppt/presProps.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
    );
    types.part(
        "ppt/viewProps.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
    );
    types.part(
        "ppt/tableStyles.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
    );
    types.part(
        "ppt/theme/theme1.xml",
        "application/vnd.openxmlformats-officedocument.theme+xml",
    );
    types.part(
        "ppt/slideMasters/slideMaster1.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
    );
    types.part(
        "ppt/slideLayouts/slideLayout1.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
    );

    if has_notes {
        parts.add_xml("ppt/notesMasters/notesMaster1.xml", notes_master_xml());
        let mut notes_master_rels = Relationships::default();
        notes_master_rels.add(&rel("theme"), "../theme/theme2.xml");
        parts.add_xml(
            "ppt/notesMasters/_rels/notesMaster1.xml.rels",
            notes_master_rels.xml(),
        );
        parts.add_xml("ppt/theme/theme2.xml", theme_xml(deck));
        types.part(
            "ppt/notesMasters/notesMaster1.xml",
            "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
        );
        types.part(
            "ppt/theme/theme2.xml",
            "application/vnd.openxmlformats-officedocument.theme+xml",
        );
    }

    for asset in &used_assets {
        let bytes = assets
            .get(asset)
            .ok_or_else(|| OfficeError::corrupt(format!("embedded picture {asset} is missing")))?;
        if let Some(kind) = kind_of_asset(asset) {
            types.extension(kind.extension(), kind.content_type());
        }
        parts.add(format!("ppt/media/{asset}"), bytes.clone());
    }
    add_common_parts(
        &mut parts,
        &mut types,
        "ppt/presentation.xml",
        &deck.properties,
        created,
        modified,
        "OpenBitFun GenOfficeFile",
    );
    parts.add_xml("[Content_Types].xml", types.xml());
    Ok(parts)
}

fn slide_emu(size: SlideSize) -> (i64, i64) {
    let (width, height) = size.canvas();
    (emu(width), emu(height))
}

struct SlideWriter<'a> {
    deck: &'a PptxDocument,
    assets: &'a BTreeMap<String, Vec<u8>>,
    rels: &'a mut Relationships,
    used_assets: &'a mut Vec<String>,
    image_rels: BTreeMap<String, String>,
    link_rels: BTreeMap<String, String>,
    next_id: u32,
}

impl SlideWriter<'_> {
    fn id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn slide(mut self, slide: &Slide) -> OfficeResult<String> {
        let mut xml = format!("{XML_HEADER}<p:sld {NS}><p:cSld>");
        if let Some((rgb, _)) = slide
            .background
            .as_deref()
            .and_then(|color| parse_color(color).ok())
        {
            xml.push_str(&format!("<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{rgb}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>"));
        }
        xml.push_str(&format!("<p:spTree>{GROUP_HEADER}"));
        for element in &slide.elements {
            let shape = match element {
                Element::Shape(shape) => self.shape(shape),
                Element::Text(text) => self.text(text),
                Element::Image(image) => self.image(image)?,
                Element::Table(table) => self.table(table),
            };
            xml.push_str(&shape);
        }
        xml.push_str(
            "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        );
        Ok(xml)
    }

    fn link(&mut self, target: &str) -> String {
        if let Some(id) = self.link_rels.get(target) {
            return id.clone();
        }
        let id = self.rels.add_external(&rel("hyperlink"), target);
        self.link_rels.insert(target.to_string(), id.clone());
        id
    }

    fn shape(&mut self, shape: &ShapeElement) -> String {
        let id = self.id();
        let is_line = shape.shape == "line" || shape.shape == "lineArrow";
        let preset = if is_line {
            "line"
        } else {
            shape.shape.as_str()
        };
        let mut xml = format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{} {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>", esc(&shape.shape));
        xml.push_str(&xfrm(
            shape.x,
            shape.y,
            shape.w,
            shape.h,
            shape.rotation,
            shape.flip_h,
            shape.flip_v,
        ));
        xml.push_str(&format!(
            "<a:prstGeom prst=\"{preset}\"><a:avLst/></a:prstGeom>"
        ));
        xml.push_str(&match &shape.fill {
            Some(fill) => solid_fill(fill),
            None => "<a:noFill/>".to_string(),
        });
        match &shape.stroke {
            Some(stroke) => {
                let width = (stroke.width_pt * EMU_PER_PT).round() as i64;
                xml.push_str(&format!(
                    "<a:ln w=\"{width}\">{}",
                    solid_fill(&stroke.color)
                ));
                match stroke.dash.as_deref() {
                    Some("dash") => xml.push_str("<a:prstDash val=\"dash\"/>"),
                    Some("dot") => xml.push_str("<a:prstDash val=\"sysDot\"/>"),
                    _ => {}
                }
                if shape.shape == "lineArrow" {
                    xml.push_str("<a:tailEnd type=\"triangle\" w=\"med\" len=\"med\"/>");
                }
                xml.push_str("</a:ln>");
            }
            None => xml.push_str("<a:ln><a:noFill/></a:ln>"),
        }
        xml.push_str("</p:spPr>");
        if !shape.paragraphs.is_empty() {
            let inset = shape.padding.map(emu).unwrap_or(0);
            xml.push_str(&self.text_body(
                &shape.paragraphs,
                &shape.defaults,
                shape.valign.unwrap_or(VerticalAlign::Middle),
                inset,
            ));
        }
        xml.push_str("</p:sp>");
        xml
    }

    fn text(&mut self, text: &TextElement) -> String {
        let id = self.id();
        let mut xml = format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"TextBox {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr>");
        xml.push_str(&xfrm(
            text.x,
            text.y,
            text.w,
            text.h,
            text.rotation,
            false,
            false,
        ));
        xml.push_str("<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>");
        xml.push_str(&self.text_body(
            &text.paragraphs,
            &text.defaults,
            text.valign.unwrap_or(VerticalAlign::Top),
            0,
        ));
        xml.push_str("</p:sp>");
        xml
    }

    fn text_body(
        &mut self,
        paragraphs: &[Paragraph],
        defaults: &TextDefaults,
        valign: VerticalAlign,
        inset: i64,
    ) -> String {
        let anchor = match valign {
            VerticalAlign::Top => "t",
            VerticalAlign::Middle => "ctr",
            VerticalAlign::Bottom => "b",
        };
        let mut xml = format!(
            "<p:txBody><a:bodyPr wrap=\"square\" lIns=\"{inset}\" tIns=\"{inset}\" rIns=\"{inset}\" bIns=\"{inset}\" rtlCol=\"0\" anchor=\"{anchor}\"><a:noAutofit/></a:bodyPr><a:lstStyle/>"
        );
        for paragraph in paragraphs {
            xml.push_str(&self.paragraph(paragraph, defaults));
        }
        xml.push_str("</p:txBody>");
        xml
    }

    fn paragraph(&mut self, paragraph: &Paragraph, defaults: &TextDefaults) -> String {
        let mut ppr = String::new();
        let align = paragraph.align.or(defaults.align);
        let mut attributes = String::new();
        if let Some(align) = align {
            let value = match align {
                Align::Left => "l",
                Align::Center => "ctr",
                Align::Right => "r",
                Align::Justify => "just",
            };
            attributes.push_str(&format!(" algn=\"{value}\""));
        }
        let size = paragraph
            .runs
            .iter()
            .filter_map(|run| run.size_pt)
            .fold(None, |max: Option<f64>, size| {
                Some(max.map_or(size, |current| current.max(size)))
            })
            .or(defaults.size_pt)
            .unwrap_or(18.0);
        if paragraph.bullet || paragraph.numbered {
            let indent = emu(size * 1.333 * 1.1).max(emu(16.0));
            let margin = indent * (paragraph.level as i64 + 1);
            attributes.push_str(&format!(" marL=\"{margin}\" indent=\"-{indent}\""));
        } else if paragraph.level > 0 {
            attributes.push_str(&format!(" marL=\"{}\"", emu(24.0) * paragraph.level as i64));
        }
        if paragraph.level > 0 {
            attributes.push_str(&format!(" lvl=\"{}\"", paragraph.level.min(8)));
        }
        if let Some(spacing) = paragraph.line_spacing_pct {
            ppr.push_str(&format!(
                "<a:lnSpc><a:spcPct val=\"{}\"/></a:lnSpc>",
                (spacing * 1000.0).round() as i64
            ));
        }
        if let Some(before) = paragraph.space_before_pt {
            ppr.push_str(&format!(
                "<a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>",
                (before * 100.0).round() as i64
            ));
        }
        if let Some(after) = paragraph.space_after_pt {
            ppr.push_str(&format!(
                "<a:spcAft><a:spcPts val=\"{}\"/></a:spcAft>",
                (after * 100.0).round() as i64
            ));
        }
        if paragraph.numbered {
            ppr.push_str("<a:buFont typeface=\"+mj-lt\"/><a:buAutoNum type=\"arabicPeriod\"/>");
        } else if paragraph.bullet {
            ppr.push_str("<a:buFont typeface=\"Arial\"/><a:buChar char=\"•\"/>");
        } else {
            ppr.push_str("<a:buNone/>");
        }
        let mut xml = format!("<a:p><a:pPr{attributes}>{ppr}</a:pPr>");
        for run in &paragraph.runs {
            for (index, line) in run.text.split('\n').enumerate() {
                if index > 0 {
                    xml.push_str(&format!(
                        "<a:br>{}</a:br>",
                        self.run_properties(run, defaults, "a:rPr")
                    ));
                }
                if line.is_empty() {
                    continue;
                }
                xml.push_str(&format!(
                    "<a:r>{}<a:t>{}</a:t></a:r>",
                    self.run_properties(run, defaults, "a:rPr"),
                    esc(line)
                ));
            }
        }
        let end = Run {
            size_pt: Some(size),
            ..Run::default()
        };
        xml.push_str(&self.run_properties(&end, defaults, "a:endParaRPr"));
        xml.push_str("</a:p>");
        xml
    }

    fn run_properties(&mut self, run: &Run, defaults: &TextDefaults, tag: &str) -> String {
        let mut attributes = String::from(" lang=\"en-US\"");
        if let Some(size) = run.size_pt.or(defaults.size_pt) {
            attributes.push_str(&format!(" sz=\"{}\"", (size * 100.0).round() as i64));
        }
        if run.bold.or(defaults.bold) == Some(true) {
            attributes.push_str(" b=\"1\"");
        }
        if run.italic.or(defaults.italic) == Some(true) {
            attributes.push_str(" i=\"1\"");
        }
        if run.underline == Some(true) {
            attributes.push_str(" u=\"sng\"");
        }
        if run.strike == Some(true) {
            attributes.push_str(" strike=\"sngStrike\"");
        }
        if run.superscript == Some(true) {
            attributes.push_str(" baseline=\"30000\"");
        } else if run.subscript == Some(true) {
            attributes.push_str(" baseline=\"-25000\"");
        }
        attributes.push_str(" dirty=\"0\"");
        let mut children = String::new();
        let color = run.color.as_deref().or(defaults.color.as_deref()).or(self
            .deck
            .theme
            .text_color
            .as_deref());
        if let Some(color) = color {
            children.push_str(&solid_fill(color));
        }
        if let Some((rgb, _)) = run
            .highlight
            .as_deref()
            .and_then(|color| parse_color(color).ok())
        {
            children.push_str(&format!(
                "<a:highlight><a:srgbClr val=\"{rgb}\"/></a:highlight>"
            ));
        }
        let font = run
            .font
            .as_deref()
            .or(defaults.font.as_deref())
            .or_else(|| (run.code == Some(true)).then_some("Consolas"));
        if let Some(font) = font {
            let font = esc(font);
            children.push_str(&format!("<a:latin typeface=\"{font}\"/><a:ea typeface=\"{font}\"/><a:cs typeface=\"{font}\"/>"));
        }
        if let Some(link) = &run.link {
            let id = self.link(link);
            children.push_str(&format!("<a:hlinkClick r:id=\"{id}\"/>"));
        }
        if children.is_empty() {
            format!("<{tag}{attributes}/>")
        } else {
            format!("<{tag}{attributes}>{children}</{tag}>")
        }
    }

    fn image(&mut self, image: &ImageElement) -> OfficeResult<String> {
        let asset = image
            .asset
            .as_deref()
            .ok_or_else(|| OfficeError::corrupt("image element without an embedded picture"))?;
        let bytes = self
            .assets
            .get(asset)
            .ok_or_else(|| OfficeError::corrupt(format!("embedded picture {asset} is missing")))?;
        let info = sniff(bytes)?;
        let rel_id = match self.image_rels.get(asset) {
            Some(id) => id.clone(),
            None => {
                let id = self.rels.add(&rel("image"), &format!("../media/{asset}"));
                self.image_rels.insert(asset.to_string(), id.clone());
                if !self.used_assets.iter().any(|used| used == asset) {
                    self.used_assets.push(asset.to_string());
                }
                id
            }
        };
        let picture = info.width as f64 / info.height as f64;
        let frame = image.w / image.h.max(0.01);
        let (mut x, mut y, mut w, mut h) = (image.x, image.y, image.w, image.h);
        let mut crop = String::new();
        match image.fit {
            ImageFit::Cover => {
                if picture > frame * 1.001 {
                    let keep = frame / picture;
                    let side = ((1.0 - keep) / 2.0 * 100_000.0).round() as i64;
                    crop = format!("<a:srcRect l=\"{side}\" r=\"{side}\"/>");
                } else if frame > picture * 1.001 {
                    let keep = picture / frame;
                    let side = ((1.0 - keep) / 2.0 * 100_000.0).round() as i64;
                    crop = format!("<a:srcRect t=\"{side}\" b=\"{side}\"/>");
                }
            }
            ImageFit::Contain => {
                if picture > frame {
                    let height = w / picture;
                    y += (h - height) / 2.0;
                    h = height;
                } else {
                    let width = h * picture;
                    x += (w - width) / 2.0;
                    w = width;
                }
            }
            ImageFit::Stretch => {}
        }
        let id = self.id();
        let descr = esc(image.alt.as_deref().unwrap_or(""));
        let mut xml = format!("<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"Picture {id}\" descr=\"{descr}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"{rel_id}\"/>{crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>");
        xml.push_str(&xfrm(x, y, w, h, image.rotation, false, false));
        xml.push_str("<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>");
        Ok(xml)
    }

    fn table(&mut self, table: &TableElement) -> String {
        let id = self.id();
        let columns = table.rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
        let widths: Vec<f64> = match &table.column_widths {
            Some(widths) if !widths.is_empty() => {
                let raw: Vec<f64> = (0..columns)
                    .map(|index| {
                        *widths
                            .get(index)
                            .unwrap_or_else(|| widths.last().expect("non-empty"))
                    })
                    .collect();
                let sum: f64 = raw.iter().sum();
                raw.iter().map(|width| width * table.w / sum).collect()
            }
            _ => vec![table.w / columns as f64; columns],
        };
        let row_height = table.h / table.rows.len().max(1) as f64;
        let mut xml = format!("<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"Table {id}\"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp=\"1\"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\"><a:tbl><a:tblPr firstRow=\"{}\" bandRow=\"1\"/><a:tblGrid>",
            emu(table.x), emu(table.y), emu(table.w), emu(table.h), u8::from(table.header));
        for width in &widths {
            xml.push_str(&format!("<a:gridCol w=\"{}\"/>", emu(*width)));
        }
        xml.push_str("</a:tblGrid>");
        let border = solid_fill(&table.border_color);
        for (row_index, row) in table.rows.iter().enumerate() {
            let is_header = table.header && row_index == 0;
            xml.push_str(&format!("<a:tr h=\"{}\">", emu(row_height)));
            for column in 0..columns {
                let cell = row.get(column).cloned().unwrap_or_default();
                let defaults = TextDefaults {
                    size_pt: Some(table.font_size_pt),
                    bold: cell.bold.or(is_header.then_some(true)),
                    italic: None,
                    color: cell
                        .color
                        .clone()
                        .or_else(|| is_header.then(|| table.header_color.clone()))
                        .or_else(|| table.text_color.clone()),
                    font: table.font.clone(),
                    align: cell.align,
                };
                let paragraph = Paragraph {
                    runs: cell.runs.clone(),
                    ..Paragraph::default()
                };
                xml.push_str("<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>");
                xml.push_str(&self.paragraph(&paragraph, &defaults));
                xml.push_str("</a:txBody><a:tcPr marL=\"76200\" marR=\"76200\" marT=\"38100\" marB=\"38100\" anchor=\"ctr\">");
                for side in ["lnL", "lnR", "lnT", "lnB"] {
                    xml.push_str(&format!("<a:{side} w=\"9525\">{border}</a:{side}>"));
                }
                let body_index = if table.header {
                    row_index.saturating_sub(1)
                } else {
                    row_index
                };
                let fill = cell.fill.clone().or_else(|| {
                    if is_header {
                        Some(table.header_fill.clone())
                    } else if !table.band_fill.is_empty() && body_index % 2 == 1 {
                        Some(table.band_fill.clone())
                    } else {
                        table.fill.clone()
                    }
                });
                xml.push_str(&match fill {
                    Some(fill) => solid_fill(&fill),
                    None => "<a:noFill/>".to_string(),
                });
                xml.push_str("</a:tcPr></a:tc>");
            }
            xml.push_str("</a:tr>");
        }
        xml.push_str("</a:tbl></a:graphicData></a:graphic></p:graphicFrame>");
        xml
    }
}

fn xfrm(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rotation: Option<f64>,
    flip_h: bool,
    flip_v: bool,
) -> String {
    let mut attributes = String::new();
    if let Some(rotation) = rotation.filter(|rotation| *rotation != 0.0) {
        let normalized = rotation.rem_euclid(360.0);
        attributes.push_str(&format!(
            " rot=\"{}\"",
            (normalized * 60_000.0).round() as i64
        ));
    }
    if flip_h {
        attributes.push_str(" flipH=\"1\"");
    }
    if flip_v {
        attributes.push_str(" flipV=\"1\"");
    }
    format!(
        "<a:xfrm{attributes}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>",
        emu(x),
        emu(y),
        emu(w).max(0),
        emu(h).max(0)
    )
}

fn solid_fill(color: &str) -> String {
    match parse_color(color) {
        Ok((rgb, Some(alpha))) => format!(
            "<a:solidFill><a:srgbClr val=\"{rgb}\"><a:alpha val=\"{}\"/></a:srgbClr></a:solidFill>",
            (alpha as f64 / 255.0 * 100_000.0).round() as i64
        ),
        Ok((rgb, None)) => format!("<a:solidFill><a:srgbClr val=\"{rgb}\"/></a:solidFill>"),
        Err(_) => "<a:noFill/>".to_string(),
    }
}

fn level_styles(size: u32) -> String {
    (1..=9)
        .map(|level| {
            format!(
                "<a:lvl{level}pPr marL=\"{}\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:defRPr sz=\"{size}\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl{level}pPr>",
                (level - 1) * 457200
            )
        })
        .collect()
}

fn master_xml() -> String {
    format!(
        "{XML_HEADER}<p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{GROUP_HEADER}</p:spTree></p:cSld>{CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:lnSpc><a:spcPct val=\"90000\"/></a:lnSpc><a:spcBef><a:spcPct val=\"0\"/></a:spcBef><a:buNone/><a:defRPr sz=\"4400\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mj-lt\"/><a:ea typeface=\"+mj-ea\"/><a:cs typeface=\"+mj-cs\"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>{}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr>{}</p:otherStyle></p:txStyles></p:sldMaster>",
        level_styles(1800),
        level_styles(1800)
    )
}

fn notes_master_xml() -> String {
    format!(
        "{XML_HEADER}<p:notesMaster {NS}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{GROUP_HEADER}<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\" idx=\"2\"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"685800\" y=\"1143000\"/><a:ext cx=\"5486400\" cy=\"3086100\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln w=\"12700\"><a:solidFill><a:prstClr val=\"black\"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" sz=\"quarter\" idx=\"3\"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"685800\" y=\"4400550\"/><a:ext cx=\"5486400\" cy=\"3600450\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" rtlCol=\"0\"/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp></p:spTree></p:cSld>{CLR_MAP}<p:notesStyle>{}</p:notesStyle></p:notesMaster>",
        level_styles(1200)
    )
}

fn notes_xml(notes: &str) -> String {
    let paragraphs: String = notes
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                "<a:p><a:endParaRPr lang=\"en-US\" dirty=\"0\"/></a:p>".to_string()
            } else {
                format!(
                    "<a:p><a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>",
                    esc(line)
                )
            }
        })
        .collect();
    format!(
        "{XML_HEADER}<p:notes {NS}><p:cSld><p:spTree>{GROUP_HEADER}<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
    )
}

fn theme_xml(deck: &PptxDocument) -> String {
    let latin = esc(deck.theme.font.as_deref().unwrap_or("Calibri"));
    let east_asia = esc(deck.theme.east_asia_font.as_deref().unwrap_or(""));
    let dark = deck
        .theme
        .text_color
        .as_deref()
        .and_then(|color| parse_color(color).ok())
        .map(|(rgb, _)| format!("<a:srgbClr val=\"{rgb}\"/>"))
        .unwrap_or_else(|| "<a:sysClr val=\"windowText\" lastClr=\"000000\"/>".to_string());
    let font_set = |name: &str| {
        format!(
            "<a:{name}><a:latin typeface=\"{latin}\"/><a:ea typeface=\"{east_asia}\"/><a:cs typeface=\"\"/><a:font script=\"Jpan\" typeface=\"游ゴシック\"/><a:font script=\"Hang\" typeface=\"맑은 고딕\"/><a:font script=\"Hans\" typeface=\"等线\"/><a:font script=\"Hant\" typeface=\"新細明體\"/></a:{name}>"
        )
    };
    let fill_variants = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"><a:tint val=\"50000\"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"><a:shade val=\"80000\"/></a:schemeClr></a:solidFill>";
    format!(
        "{XML_HEADER}<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"OpenBitFun\"><a:themeElements><a:clrScheme name=\"OpenBitFun\"><a:dk1>{dark}</a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2><a:accent1><a:srgbClr val=\"4472C4\"/></a:accent1><a:accent2><a:srgbClr val=\"ED7D31\"/></a:accent2><a:accent3><a:srgbClr val=\"A5A5A5\"/></a:accent3><a:accent4><a:srgbClr val=\"FFC000\"/></a:accent4><a:accent5><a:srgbClr val=\"5B9BD5\"/></a:accent5><a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6><a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"OpenBitFun\">{}{}</a:fontScheme><a:fmtScheme name=\"OpenBitFun\"><a:fillStyleLst>{fill_variants}</a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln><a:ln w=\"12700\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln><a:ln w=\"19050\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>{fill_variants}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>",
        font_set("majorFont"),
        font_set("minorFont")
    )
}
