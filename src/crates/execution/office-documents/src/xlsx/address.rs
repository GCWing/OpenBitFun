//! A1-style cell addressing.

use crate::error::{OfficeError, OfficeResult};
use std::fmt;

pub(crate) const MAX_ROWS: u32 = 1_048_576;
pub(crate) const MAX_COLUMNS: u32 = 16_384;

/// One-based row and column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CellRef {
    pub row: u32,
    pub col: u32,
}

impl CellRef {
    pub fn new(row: u32, col: u32) -> Self {
        Self { row, col }
    }
}

impl fmt::Display for CellRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}{}", column_letters(self.col), self.row)
    }
}

/// Inclusive rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CellRange {
    pub start: CellRef,
    pub end: CellRef,
}

impl CellRange {
    pub(crate) fn contains(&self, cell: CellRef) -> bool {
        (self.start.row..=self.end.row).contains(&cell.row)
            && (self.start.col..=self.end.col).contains(&cell.col)
    }

    pub(crate) fn intersects(&self, other: &CellRange) -> bool {
        self.start.row <= other.end.row
            && other.start.row <= self.end.row
            && self.start.col <= other.end.col
            && other.start.col <= self.end.col
    }

    pub(crate) fn cell_count(&self) -> u64 {
        (self.end.row - self.start.row + 1) as u64 * (self.end.col - self.start.col + 1) as u64
    }

    pub(crate) fn is_single(&self) -> bool {
        self.start == self.end
    }
}

impl fmt::Display for CellRange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_single() {
            write!(formatter, "{}", self.start)
        } else {
            write!(formatter, "{}:{}", self.start, self.end)
        }
    }
}

pub(crate) fn column_letters(mut col: u32) -> String {
    let mut letters = Vec::new();
    while col > 0 {
        let remainder = ((col - 1) % 26) as u8;
        letters.push((b'A' + remainder) as char);
        col = (col - 1) / 26;
    }
    letters.iter().rev().collect()
}

pub(crate) fn column_number(letters: &str) -> Option<u32> {
    if letters.is_empty() || letters.len() > 3 || !letters.chars().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    let mut value: u32 = 0;
    for character in letters.chars() {
        value = value * 26 + (character.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    (value <= MAX_COLUMNS).then_some(value)
}

pub(crate) fn parse_column(input: &str) -> OfficeResult<u32> {
    column_number(input.trim().trim_start_matches('$')).ok_or_else(|| {
        OfficeError::invalid(format!(
            "invalid column `{input}`; use letters such as A or AB"
        ))
    })
}

pub(crate) fn parse_cell(input: &str) -> OfficeResult<CellRef> {
    let cleaned: String = input.trim().chars().filter(|c| *c != '$').collect();
    let split = cleaned
        .find(|c: char| c.is_ascii_digit())
        .ok_or_else(|| invalid_cell(input))?;
    let (letters, digits) = cleaned.split_at(split);
    let col = column_number(letters).ok_or_else(|| invalid_cell(input))?;
    let row: u32 = digits.parse().map_err(|_| invalid_cell(input))?;
    if row == 0 || row > MAX_ROWS {
        return Err(OfficeError::out_of_range(format!(
            "row {row} in `{input}` is outside 1..={MAX_ROWS}"
        )));
    }
    Ok(CellRef { row, col })
}

fn invalid_cell(input: &str) -> OfficeError {
    OfficeError::invalid(format!(
        "invalid cell address `{input}`; use A1 style such as B3"
    ))
}

/// Parses `A1` or `A1:C9` (either corner order).
pub(crate) fn parse_range(input: &str) -> OfficeResult<CellRange> {
    let (first, second) = match input.split_once(':') {
        Some((a, b)) => (parse_cell(a)?, parse_cell(b)?),
        None => {
            let cell = parse_cell(input)?;
            (cell, cell)
        }
    };
    Ok(CellRange {
        start: CellRef::new(first.row.min(second.row), first.col.min(second.col)),
        end: CellRef::new(first.row.max(second.row), first.col.max(second.col)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_columns_both_ways() {
        for (number, letters) in [
            (1, "A"),
            (26, "Z"),
            (27, "AA"),
            (702, "ZZ"),
            (703, "AAA"),
            (16384, "XFD"),
        ] {
            assert_eq!(column_letters(number), letters);
            assert_eq!(column_number(letters), Some(number));
        }
        assert_eq!(column_number("XFE"), None);
    }

    #[test]
    fn parses_ranges_in_any_corner_order() {
        let range = parse_range("$C$5:A1").unwrap();
        assert_eq!(range.to_string(), "A1:C5");
        assert!(parse_cell("A0").is_err());
        assert!(parse_cell("1A").is_err());
    }
}
