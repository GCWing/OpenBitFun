//! Pure OCR matching and screenshot-coordinate projection; no OS calls.
use super::screen_ocr::OcrTextMatch;
use openbitfun_agent_tools::computer_use_host::ComputerScreenshot;

/// Normalize for substring / fuzzy matching. Strips **all** Unicode whitespace so that
/// Vision output like `"尉 怡 青"` or `"尉怡 青"` still matches query `"尉怡青"` (CJK UIs often
/// insert spaces between glyphs). Latin phrases become `"helloworld"`-style; substring checks
/// remain meaningful for short tokens.
pub(super) fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// Levenshtein distance on Unicode scalar values (not UTF-8 bytes).
pub(super) fn levenshtein_chars(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let n = a.len();
    let m = b.len();
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr = vec![0usize; m + 1];
    for (i, a_ch) in a.iter().enumerate().take(n) {
        curr[0] = i + 1;
        for j in 0..m {
            let cost = usize::from(*a_ch != b[j]);
            curr[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(curr[j] + 1);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

/// Max allowed edit distance for fuzzy OCR match (Vision mis-reads one CJK glyph, etc.).
fn fuzzy_max_distance(query_len_chars: usize) -> usize {
    match query_len_chars {
        0 => 0,
        1 => 0,
        2..=4 => 1,
        5..=8 => 2,
        _ => 3,
    }
}

pub(super) fn fuzzy_text_matches_query(ocr_text: &str, query: &str) -> bool {
    let t = normalize_for_match(ocr_text);
    let q = normalize_for_match(query);
    if q.is_empty() {
        return false;
    }
    if t.contains(&q) {
        return true;
    }
    let ql = q.chars().count();
    let dist = levenshtein_chars(&t, &q);
    dist <= fuzzy_max_distance(ql)
}

#[cfg(test)]
mod ocr_match_tests {
    use super::*;

    #[test]
    fn normalize_strips_whitespace_for_cjk_substring() {
        let q = normalize_for_match("尉怡青");
        assert!(normalize_for_match("尉 怡 青").contains(&q));
        assert!(normalize_for_match(" 尉怡 青 ").contains(&q));
    }

    #[test]
    fn fuzzy_one_glyph_substitution_three_chars() {
        assert!(fuzzy_text_matches_query("卫怡青", "尉怡青"));
    }

    #[test]
    fn levenshtein_ascii() {
        assert_eq!(levenshtein_chars("cat", "cats"), 1);
    }

    fn shot() -> ComputerScreenshot {
        serde_json::from_value(serde_json::json!({
            "bytes":[], "mime_type":"image/jpeg", "image_width":1000, "image_height":800,
            "native_width":2000, "native_height":1600, "display_origin_x":-1000, "display_origin_y":0,
            "vision_scale":0.5,
            "image_content_rect":{"left":100,"top":80,"width":800,"height":640},
            "image_global_bounds":{"left":-500.0,"top":100.0,"width":400.0,"height":320.0}
        })).unwrap()
    }

    #[test]
    fn tsv_read_all_preserves_unrelated_lines_and_projects_bounds() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
5\t1\t1\t1\t1\t1\t300\t240\t40\t40\t90\tSave\n\
5\t1\t1\t1\t1\t2\t350\t240\t50\t40\t80\treport\n\
5\t1\t1\t1\t2\t1\t300\t340\t100\t40\t95\tCancel\n\
5\t1\t1\t1\t3\t1\tNaN\t340\t100\t40\t95\tinvalid\n";
        let lines = tesseract_lines_from_tsv(&shot(), tsv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Save report");
        assert_eq!(lines[1].text, "Cancel");
        assert_eq!((lines[0].center_x, lines[0].center_y), (-375.0, 190.0));
        assert!((lines[0].confidence - 0.85).abs() < 0.001);
        assert!(tesseract_lines_from_tsv(&shot(), "").is_empty());
    }

    #[test]
    fn cropped_retina_ocr_uses_global_bounds_and_content_padding() {
        let m = image_box_to_global_match(&shot(), "Save".into(), 0.9, 300.0, 240.0, 100.0, 40.0)
            .unwrap();
        assert_eq!((m.center_x, m.center_y), (-375.0, 190.0));
        assert_eq!((m.bounds_width, m.bounds_height), (50.0, 20.0));
    }

    #[test]
    fn ranks_exact_before_fuzzy_and_rejects_blank_queries_and_invalid_hits() {
        let exact =
            image_box_to_global_match(&shot(), "保存".into(), 0.6, 300.0, 240.0, 100.0, 40.0)
                .unwrap();
        let mut fuzzy = exact.clone();
        fuzzy.text = "保有".into();
        fuzzy.confidence = 0.99;
        let mut invalid = exact.clone();
        invalid.center_x = f64::NAN;
        let out = filter_and_rank("保存", vec![fuzzy, invalid, exact]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "保存");
        assert!(filter_and_rank("  ", out).is_empty());
    }

    #[test]
    fn rejects_padding_only_hits_and_invalid_mapping_but_keeps_legacy_raw_shots() {
        assert!(image_box_to_global_match(
            &shot(),
            "frame label".into(),
            0.9,
            0.0,
            0.0,
            50.0,
            40.0
        )
        .is_none());
        let mut invalid = shot();
        invalid.image_content_rect.as_mut().unwrap().width = 0;
        assert!(
            image_box_to_global_match(&invalid, "Save".into(), 0.9, 300.0, 240.0, 100.0, 40.0)
                .is_none()
        );
        let mut legacy = shot();
        legacy.image_global_bounds = None;
        let hit = image_box_to_global_match(&legacy, "Save".into(), 0.9, 300.0, 240.0, 100.0, 40.0)
            .unwrap();
        assert_eq!((hit.center_x, hit.center_y), (-375.0, 450.0));
    }
}

fn rank_matches(mut matches: Vec<OcrTextMatch>, query: &str) -> Vec<OcrTextMatch> {
    let normalized_query = normalize_for_match(query);
    matches.sort_by(|a, b| compare_match(a, b, &normalized_query));
    matches
}

fn compare_match(a: &OcrTextMatch, b: &OcrTextMatch, normalized_query: &str) -> std::cmp::Ordering {
    let sa = match_score(a, normalized_query);
    let sb = match_score(b, normalized_query);
    sb.cmp(&sa)
        .then_with(|| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| {
            let da = normalized_len_delta(&a.text, normalized_query);
            let db = normalized_len_delta(&b.text, normalized_query);
            da.cmp(&db)
        })
}

fn match_score(m: &OcrTextMatch, normalized_query: &str) -> i32 {
    let text = normalize_for_match(&m.text);
    if text == normalized_query {
        4
    } else if text.starts_with(normalized_query) {
        3
    } else if text.contains(normalized_query) {
        2
    } else {
        1
    }
}

fn normalized_len_delta(text: &str, normalized_query: &str) -> usize {
    let l = normalize_for_match(text).chars().count();
    let q = normalized_query.chars().count();
    l.abs_diff(q)
}

pub(super) fn filter_and_rank(query: &str, raw_matches: Vec<OcrTextMatch>) -> Vec<OcrTextMatch> {
    let normalized_query = normalize_for_match(query);
    if normalized_query.is_empty() {
        return Vec::new();
    }
    let filtered = raw_matches
        .into_iter()
        .filter(|m| {
            let t = normalize_for_match(&m.text);
            m.confidence.is_finite()
                && (0.0..=1.0).contains(&m.confidence)
                && [
                    m.center_x,
                    m.center_y,
                    m.bounds_left,
                    m.bounds_top,
                    m.bounds_width,
                    m.bounds_height,
                ]
                .iter()
                .all(|v| v.is_finite())
                && m.bounds_width > 0.0
                && m.bounds_height > 0.0
                && !t.is_empty()
                && (t.contains(&normalized_query) || fuzzy_text_matches_query(&m.text, query))
        })
        .collect::<Vec<_>>();
    rank_matches(filtered, query)
}

pub(super) fn image_content_rect_or_full(shot: &ComputerScreenshot) -> (u32, u32, u32, u32) {
    if let Some(rect) = &shot.image_content_rect {
        (rect.left, rect.top, rect.width, rect.height)
    } else {
        (0, 0, shot.image_width, shot.image_height)
    }
}

/// Map a rectangle in **full JPEG pixel space** (top-left origin) to global pointer coordinates.
/// Uses `image_content_rect`: only the inner content area maps linearly to `native_width` × `native_height`.
pub(super) fn image_box_to_global_match(
    shot: &ComputerScreenshot,
    text: String,
    confidence: f32,
    local_left: f64,
    local_top: f64,
    width: f64,
    height: f64,
) -> Option<OcrTextMatch> {
    let (cl, ct, cw, ch) = image_content_rect_or_full(shot);
    if cw == 0
        || ch == 0
        || cl.checked_add(cw)? > shot.image_width
        || ct.checked_add(ch)? > shot.image_height
        || ![local_left, local_top, width, height]
            .iter()
            .all(|v| v.is_finite())
        || width <= 0.0
        || height <= 0.0
    {
        return None;
    }
    let cw = cw as f64;
    let ch = ch as f64;
    let cl = cl as f64;
    let ct = ct as f64;
    let left = local_left.max(cl);
    let top = local_top.max(ct);
    let right = (local_left + width).min(cl + cw);
    let bottom = (local_top + height).min(ct + ch);
    if right <= left || bottom <= top {
        return None;
    }
    let rel_x = left - cl;
    let rel_y = top - ct;
    // Modern captures carry the authoritative pointer-space crop bounds.
    // Keep the historical origin/span interpretation for older raw OCR shots.
    let (ox, oy, nw, nh) = shot
        .image_global_bounds
        .as_ref()
        .map(|b| (b.left, b.top, b.width, b.height))
        .unwrap_or((
            shot.display_origin_x as f64,
            shot.display_origin_y as f64,
            shot.native_width as f64,
            shot.native_height as f64,
        ));
    if ![ox, oy, nw, nh].iter().all(|v| v.is_finite()) || nw <= 0.0 || nh <= 0.0 {
        return None;
    }
    let global_left = ox + (rel_x / cw) * nw;
    let global_top = oy + (rel_y / ch) * nh;
    let global_width = ((right - left) / cw) * nw;
    let global_height = ((bottom - top) / ch) * nh;
    let center_x = global_left + global_width / 2.0;
    let center_y = global_top + global_height / 2.0;
    Some(OcrTextMatch {
        text,
        confidence,
        center_x,
        center_y,
        bounds_left: global_left,
        bounds_top: global_top,
        bounds_width: global_width,
        bounds_height: global_height,
    })
}

/// Tesseract TSV word rows include page/block/paragraph/line identity. Group
/// those words into complete lines without re-running OCR for each rectangle.
#[cfg(any(target_os = "linux", test))]
pub(super) fn tesseract_lines_from_tsv(shot: &ComputerScreenshot, tsv: &str) -> Vec<OcrTextMatch> {
    use std::collections::BTreeMap;
    struct Line {
        text: Vec<String>,
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
        confidence: f64,
    }
    let mut lines: BTreeMap<[u32; 4], Line> = BTreeMap::new();
    for row in tsv.lines() {
        let fields: Vec<&str> = row.splitn(12, '\t').collect();
        if fields.len() != 12 || fields[0] != "5" || fields[11].trim().is_empty() {
            continue;
        }
        let parsed: Option<Vec<f64>> = fields[6..11]
            .iter()
            .map(|field| field.parse::<f64>().ok())
            .collect();
        let Some(values) = parsed else {
            continue;
        };
        let (left, top, width, height, confidence) =
            (values[0], values[1], values[2], values[3], values[4]);
        if !values.iter().all(|value| value.is_finite())
            || width <= 0.0
            || height <= 0.0
            || !(0.0..=100.0).contains(&confidence)
        {
            continue;
        }
        let identity: Option<Vec<u32>> = fields[1..5]
            .iter()
            .map(|field| field.parse().ok())
            .collect();
        let Some(identity) = identity else {
            continue;
        };
        let line = lines
            .entry([identity[0], identity[1], identity[2], identity[3]])
            .or_insert_with(|| Line {
                text: Vec::new(),
                left,
                top,
                right: left + width,
                bottom: top + height,
                confidence: 0.0,
            });
        line.left = line.left.min(left);
        line.top = line.top.min(top);
        line.right = line.right.max(left + width);
        line.bottom = line.bottom.max(top + height);
        line.confidence += confidence;
        line.text.push(fields[11].trim().to_owned());
    }
    let mut output: Vec<_> = lines
        .into_values()
        .filter_map(|line| {
            image_box_to_global_match(
                shot,
                line.text.join(" "),
                (line.confidence / line.text.len() as f64 / 100.0) as f32,
                line.left,
                line.top,
                line.right - line.left,
                line.bottom - line.top,
            )
        })
        .collect();
    output.sort_by(|a, b| {
        a.bounds_top
            .total_cmp(&b.bounds_top)
            .then_with(|| a.bounds_left.total_cmp(&b.bounds_left))
    });
    output
}
