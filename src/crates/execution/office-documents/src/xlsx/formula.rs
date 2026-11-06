//! Reference rewriting in formulas when rows/columns move or sheets are renamed.
//!
//! The scanner understands string literals, quoted and bare sheet prefixes,
//! cell references, and whole-column (`A:C`) and whole-row (`2:5`) ranges.
//! Everything else is copied verbatim.

use super::address::{column_letters, column_number, MAX_COLUMNS, MAX_ROWS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Axis {
    Row,
    Column,
}

/// Insertion (`delta > 0`) or deletion (`delta < 0`) of whole rows or
/// columns starting at the one-based index `at` of `sheet`.
#[derive(Debug, Clone)]
pub(crate) struct Shift {
    pub sheet: String,
    pub axis: Axis,
    pub at: u32,
    pub delta: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartKind {
    Cell,
    Column,
    Row,
}

#[derive(Debug, Clone, Copy)]
struct Part {
    kind: PartKind,
    col_abs: bool,
    col: u32,
    row_abs: bool,
    row: u32,
}

impl Part {
    fn render(&self) -> String {
        let col = || {
            format!(
                "{}{}",
                if self.col_abs { "$" } else { "" },
                column_letters(self.col)
            )
        };
        let row = || format!("{}{}", if self.row_abs { "$" } else { "" }, self.row);
        match self.kind {
            PartKind::Cell => format!("{}{}", col(), row()),
            PartKind::Column => col(),
            PartKind::Row => row(),
        }
    }
}

#[derive(Debug, Clone)]
struct Reference {
    /// Raw prefix including the `!`, kept verbatim unless renamed.
    prefix: Option<String>,
    sheet: Option<String>,
    first: Part,
    second: Option<Part>,
}

enum Token {
    Text(String),
    Ref(Reference),
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '.'
}

fn tokenize(formula: &str) -> Vec<Token> {
    let chars: Vec<char> = formula.chars().collect();
    let mut tokens = Vec::new();
    let mut text = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            text.push(c);
            i += 1;
            while i < chars.len() {
                text.push(chars[i]);
                if chars[i] == '"' {
                    if chars.get(i + 1) == Some(&'"') {
                        text.push('"');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        let boundary =
            i == 0 || !(is_name_char(chars[i - 1]) || chars[i - 1] == '$' || chars[i - 1] == '!');
        if boundary {
            if let Some((reference, next)) = parse_reference(&chars, i) {
                if !text.is_empty() {
                    tokens.push(Token::Text(std::mem::take(&mut text)));
                }
                tokens.push(Token::Ref(reference));
                i = next;
                continue;
            }
        }
        text.push(c);
        i += 1;
    }
    if !text.is_empty() {
        tokens.push(Token::Text(text));
    }
    tokens
}

fn parse_reference(chars: &[char], start: usize) -> Option<(Reference, usize)> {
    let (prefix, sheet, mut i) = parse_sheet_prefix(chars, start).unwrap_or((None, None, start));
    let (first, next) = parse_part(chars, i)?;
    i = next;
    let mut second = None;
    if chars.get(i) == Some(&':') {
        if let Some((part, after)) = parse_part(chars, i + 1) {
            if part.kind == first.kind {
                second = Some(part);
                i = after;
            }
        }
    }
    // Whole-row and whole-column references only exist as ranges.
    if first.kind != PartKind::Cell && second.is_none() {
        return None;
    }
    if let Some(&next_char) = chars.get(i) {
        if is_name_char(next_char) || next_char == '(' || next_char == '!' || next_char == '$' {
            return None;
        }
    }
    Some((
        Reference {
            prefix,
            sheet,
            first,
            second,
        },
        i,
    ))
}

fn parse_sheet_prefix(
    chars: &[char],
    start: usize,
) -> Option<(Option<String>, Option<String>, usize)> {
    let mut i = start;
    if chars.get(i) == Some(&'\'') {
        let mut name = String::new();
        i += 1;
        loop {
            match chars.get(i) {
                Some('\'') if chars.get(i + 1) == Some(&'\'') => {
                    name.push('\'');
                    i += 2;
                }
                Some('\'') => {
                    i += 1;
                    break;
                }
                Some(c) => {
                    name.push(*c);
                    i += 1;
                }
                None => return None,
            }
        }
        if chars.get(i) != Some(&'!') {
            return None;
        }
        let raw: String = chars[start..=i].iter().collect();
        return Some((Some(raw), Some(name), i + 1));
    }
    while i < chars.len() && is_name_char(chars[i]) {
        i += 1;
    }
    if i > start && chars.get(i) == Some(&'!') {
        let name: String = chars[start..i].iter().collect();
        let raw: String = chars[start..=i].iter().collect();
        return Some((Some(raw), Some(name), i + 1));
    }
    None
}

fn parse_part(chars: &[char], start: usize) -> Option<(Part, usize)> {
    let mut i = start;
    let col_abs = chars.get(i) == Some(&'$');
    if col_abs {
        i += 1;
    }
    let letters_start = i;
    while i < chars.len() && chars[i].is_ascii_alphabetic() && i - letters_start < 4 {
        i += 1;
    }
    let letters: String = chars[letters_start..i].iter().collect();
    if !letters.is_empty() {
        let col = column_number(&letters)?;
        let row_abs = chars.get(i) == Some(&'$');
        let mut j = if row_abs { i + 1 } else { i };
        let digits_start = j;
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        if j > digits_start {
            let row: u32 = chars[digits_start..j]
                .iter()
                .collect::<String>()
                .parse()
                .ok()?;
            if row == 0 || row > MAX_ROWS {
                return None;
            }
            return Some((
                Part {
                    kind: PartKind::Cell,
                    col_abs,
                    col,
                    row_abs,
                    row,
                },
                j,
            ));
        }
        if row_abs {
            return None;
        }
        return Some((
            Part {
                kind: PartKind::Column,
                col_abs,
                col,
                row_abs: false,
                row: 0,
            },
            i,
        ));
    }
    // A row part: `$5` or `5` (only meaningful inside a row range).
    let digits_start = i;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start {
        return None;
    }
    let row: u32 = chars[digits_start..i]
        .iter()
        .collect::<String>()
        .parse()
        .ok()?;
    if row == 0 || row > MAX_ROWS || chars.get(i) == Some(&'.') {
        return None;
    }
    Some((
        Part {
            kind: PartKind::Row,
            col_abs: false,
            col: 0,
            row_abs: col_abs,
            row,
        },
        i,
    ))
}

#[derive(Clone, Copy)]
enum End {
    Single,
    Start,
    Finish,
}

/// Shifts one coordinate; `None` means it was deleted and cannot be kept.
fn shift_index(value: u32, shift: &Shift, end: End) -> Option<u32> {
    let at = shift.at;
    if shift.delta >= 0 {
        if value >= at {
            let shifted = value as i64 + shift.delta;
            let limit = match shift.axis {
                Axis::Row => MAX_ROWS,
                Axis::Column => MAX_COLUMNS,
            };
            return (shifted <= limit as i64).then_some(shifted as u32);
        }
        return Some(value);
    }
    let count = (-shift.delta) as u32;
    let last = at + count - 1;
    if value < at {
        Some(value)
    } else if value > last {
        Some(value - count)
    } else {
        match end {
            End::Single => None,
            End::Start => Some(at),
            End::Finish => (at > 1).then(|| at - 1),
        }
    }
}

fn shift_part(part: &mut Part, shift: &Shift, end: End) -> bool {
    match (shift.axis, part.kind) {
        (Axis::Row, PartKind::Cell | PartKind::Row) => match shift_index(part.row, shift, end) {
            Some(row) => {
                part.row = row;
                true
            }
            None => false,
        },
        (Axis::Column, PartKind::Cell | PartKind::Column) => {
            match shift_index(part.col, shift, end) {
                Some(col) => {
                    part.col = col;
                    true
                }
                None => false,
            }
        }
        _ => true,
    }
}

/// Rewrites `formula` (stored on `formula_sheet`) for a row/column shift.
pub(crate) fn shift_formula(formula: &str, formula_sheet: &str, shift: &Shift) -> String {
    let mut out = String::new();
    for token in tokenize(formula) {
        match token {
            Token::Text(text) => out.push_str(&text),
            Token::Ref(mut reference) => {
                let target = reference.sheet.as_deref().unwrap_or(formula_sheet);
                if !target.eq_ignore_ascii_case(&shift.sheet) {
                    out.push_str(&render(&reference));
                    continue;
                }
                let ok = match reference.second.as_mut() {
                    None => shift_part(&mut reference.first, shift, End::Single),
                    Some(second) => {
                        let a = shift_part(&mut reference.first, shift, End::Start);
                        let b = shift_part(second, shift, End::Finish);
                        let ordered = match shift.axis {
                            Axis::Row => reference.first.row <= second.row,
                            Axis::Column => reference.first.col <= second.col,
                        };
                        a && b && ordered
                    }
                };
                if ok {
                    out.push_str(&render(&reference));
                } else {
                    out.push_str(reference.prefix.as_deref().unwrap_or(""));
                    out.push_str("#REF!");
                }
            }
        }
    }
    out
}

/// Points sheet-qualified references at a renamed sheet.
pub(crate) fn rename_sheet_in_formula(formula: &str, old: &str, new: &str) -> String {
    let mut out = String::new();
    for token in tokenize(formula) {
        match token {
            Token::Text(text) => out.push_str(&text),
            Token::Ref(mut reference) => {
                if reference
                    .sheet
                    .as_deref()
                    .is_some_and(|sheet| sheet.eq_ignore_ascii_case(old))
                {
                    reference.prefix = Some(format!("{}!", quote_sheet_name(new)));
                    reference.sheet = Some(new.to_string());
                }
                out.push_str(&render(&reference));
            }
        }
    }
    out
}

/// Sheet names referenced with an explicit prefix.
pub(crate) fn referenced_sheets(formula: &str) -> Vec<String> {
    tokenize(formula)
        .into_iter()
        .filter_map(|token| match token {
            Token::Ref(reference) => reference.sheet,
            Token::Text(_) => None,
        })
        .collect()
}

pub(crate) fn quote_sheet_name(name: &str) -> String {
    let plain = name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && super::address::parse_cell(name).is_err();
    if plain {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

fn render(reference: &Reference) -> String {
    let mut out = reference.prefix.clone().unwrap_or_default();
    out.push_str(&reference.first.render());
    if let Some(second) = &reference.second {
        out.push(':');
        out.push_str(&second.render());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(sheet: &str, at: u32, delta: i64) -> Shift {
        Shift {
            sheet: sheet.to_string(),
            axis: Axis::Row,
            at,
            delta,
        }
    }

    #[test]
    fn inserting_rows_shifts_references_below() {
        let shift = rows("Data", 3, 2);
        assert_eq!(
            shift_formula("SUM(A1:A10)+B3*$C$4", "Data", &shift),
            "SUM(A1:A12)+B5*$C$6"
        );
        assert_eq!(shift_formula("A2+\"A5\"", "Data", &shift), "A2+\"A5\"");
        assert_eq!(
            shift_formula("Data!A5+'Other Sheet'!A5", "Summary", &shift),
            "Data!A7+'Other Sheet'!A5"
        );
        assert_eq!(shift_formula("LOG10(A9)", "Data", &shift), "LOG10(A11)");
        assert_eq!(
            shift_formula("SUM(4:6)+SUM(A:A)", "Data", &shift),
            "SUM(6:8)+SUM(A:A)"
        );
    }

    #[test]
    fn deleting_rows_shrinks_ranges_and_breaks_single_refs() {
        let shift = rows("S", 3, -2);
        assert_eq!(shift_formula("SUM(A1:A10)", "S", &shift), "SUM(A1:A8)");
        assert_eq!(shift_formula("A3+A5", "S", &shift), "#REF!+A3");
        assert_eq!(shift_formula("SUM(A3:A4)", "S", &shift), "SUM(#REF!)");
    }

    #[test]
    fn column_shift_and_rename() {
        let shift = Shift {
            sheet: "S".to_string(),
            axis: Axis::Column,
            at: 2,
            delta: 1,
        };
        assert_eq!(
            shift_formula("A1+B1+SUM(B:C)", "S", &shift),
            "A1+C1+SUM(C:D)"
        );
        assert_eq!(
            rename_sheet_in_formula("Old!A1+'Old'!B2+X!C3", "Old", "New Name"),
            "'New Name'!A1+'New Name'!B2+X!C3"
        );
        assert_eq!(
            referenced_sheets("Sales!A1+'Q 2'!B2+C3"),
            vec!["Sales", "Q 2"]
        );
    }
}
