/// Normalized, one-based document page ranges. Resolution checks the document size before
/// expanding a range so an invalid request cannot allocate an arbitrarily large page list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPageSelection {
    ranges: Vec<(u32, u32)>,
}

impl DocumentPageSelection {
    pub fn parse(input: &str) -> Result<Self, String> {
        let invalid = || {
            "pages must contain positive page numbers or ascending ranges, for example '1-3,7'"
                .to_string()
        };
        let mut ranges = Vec::new();
        for part in input.split(',') {
            let mut ends = part.trim().split('-');
            let start = ends
                .next()
                .ok_or_else(invalid)?
                .trim()
                .parse::<u32>()
                .map_err(|_| invalid())?;
            let end = match ends.next() {
                Some(end) => end.trim().parse::<u32>().map_err(|_| invalid())?,
                None => start,
            };
            if start == 0 || end < start || ends.next().is_some() {
                return Err(invalid());
            }
            ranges.push((start, end));
        }
        ranges.sort_unstable();
        let mut normalized: Vec<(u32, u32)> = Vec::new();
        for (start, end) in ranges {
            if let Some((_, previous_end)) = normalized.last_mut() {
                if start <= previous_end.saturating_add(1) {
                    *previous_end = (*previous_end).max(end);
                    continue;
                }
            }
            normalized.push((start, end));
        }
        Ok(Self { ranges: normalized })
    }

    pub fn resolve(&self, page_count: usize) -> Result<Vec<u32>, String> {
        if let Some((_, last)) = self.ranges.last() {
            if u64::from(*last) > page_count as u64 {
                return Err(format!(
                    "pages requests page {last}, but this document has {page_count} selectable pages"
                ));
            }
        }
        Ok(self
            .ranges
            .iter()
            .flat_map(|&(start, end)| start..=end)
            .collect())
    }
}

impl std::fmt::Display for DocumentPageSelection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, &(start, end)) in self.ranges.iter().enumerate() {
            if index > 0 {
                formatter.write_str(",")?;
            }
            if start == end {
                write!(formatter, "{start}")?;
            } else {
                write!(formatter, "{start}-{end}")?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_sorted_deduplicated_and_merged() {
        let selection = DocumentPageSelection::parse("7, 2-4,1, 3-5").unwrap();
        assert_eq!(selection.to_string(), "1-5,7");
        assert_eq!(selection.resolve(9).unwrap(), vec![1, 2, 3, 4, 5, 7]);
    }

    #[test]
    fn malformed_and_out_of_bounds_requests_are_rejected_before_expansion() {
        for input in [
            "",
            "0",
            "-1",
            "3-1",
            "1-",
            "1,",
            "1-2-3",
            "1.5",
            "4294967296",
        ] {
            assert!(DocumentPageSelection::parse(input).is_err(), "{input}");
        }
        let huge = DocumentPageSelection::parse("1-4294967295").unwrap();
        assert!(huge.resolve(10).unwrap_err().contains("has 10"));
        assert!(DocumentPageSelection::parse("1")
            .unwrap()
            .resolve(0)
            .is_err());
    }
}
