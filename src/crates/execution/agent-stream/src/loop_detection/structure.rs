//! Markdown structure classification for the loop-detection exclusion list.
//!
//! The plan's false-positive list requires that legitimate repetition inside
//! fenced code blocks, tables, lists, headings, block quotes, and thematic
//! breaks never counts as a text loop. Classification is line based and keeps
//! only a tiny cross-line fence state, so it can run incrementally on a stream
//! without buffering the whole output.
//!
//! Not covered on purpose: indented (four-space) code blocks and HTML blocks.
//! They are rare in agent output, and treating them as content keeps the
//! classifier predictable instead of guessing.

/// Which structure-excluded region a line belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExcludedKind {
    /// The fence delimiter line itself (``` or ~~~).
    FenceDelimiter,
    /// A line inside an open fenced code block.
    FencedCode,
    /// A markdown table row (including the delimiter row).
    Table,
    /// A list item (bullet or ordered).
    List,
    /// An ATX heading.
    Heading,
    /// A block quote line.
    Quote,
    /// A thematic break (`---`, `***`, `___`, `===`) or setext underline.
    ThematicBreak,
}

/// Open fenced-code-block state carried across lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum FenceState {
    /// Not inside a fenced code block.
    #[default]
    None,
    /// Inside a ``` fence.
    Backtick,
    /// Inside a ~~~ fence.
    Tilde,
}

/// Classification result for one line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LineDecision {
    /// `Some(kind)` when the line is excluded from repetition analysis.
    pub(crate) excluded: Option<ExcludedKind>,
    /// Fence state to carry into the next line.
    pub(crate) fence: FenceState,
}

/// Classifies one raw line and returns the next fence state.
pub(crate) fn classify_line(raw_line: &str, fence: FenceState) -> LineDecision {
    let trimmed_start = raw_line.trim_start();
    let trimmed = trimmed_start.trim_end();

    if let Some(marker) = fence_delimiter(trimmed) {
        return match fence {
            FenceState::None => LineDecision {
                excluded: Some(ExcludedKind::FenceDelimiter),
                fence: marker,
            },
            current if current == marker => LineDecision {
                excluded: Some(ExcludedKind::FenceDelimiter),
                fence: FenceState::None,
            },
            current => LineDecision {
                excluded: Some(ExcludedKind::FencedCode),
                fence: current,
            },
        };
    }

    if fence != FenceState::None {
        return LineDecision {
            excluded: Some(ExcludedKind::FencedCode),
            fence,
        };
    }

    let excluded = if is_heading(trimmed_start) {
        Some(ExcludedKind::Heading)
    } else if is_thematic_break(trimmed) {
        Some(ExcludedKind::ThematicBreak)
    } else if trimmed.starts_with('>') {
        Some(ExcludedKind::Quote)
    } else if is_list_item(trimmed_start) {
        Some(ExcludedKind::List)
    } else if is_table_row(trimmed) {
        Some(ExcludedKind::Table)
    } else {
        None
    };

    LineDecision {
        excluded,
        fence: FenceState::None,
    }
}

fn fence_delimiter(trimmed: &str) -> Option<FenceState> {
    if trimmed.starts_with("```") {
        Some(FenceState::Backtick)
    } else if trimmed.starts_with("~~~") {
        Some(FenceState::Tilde)
    } else {
        None
    }
}

fn is_heading(trimmed_start: &str) -> bool {
    let hashes = trimmed_start.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return false;
    }
    match trimmed_start.chars().nth(hashes) {
        None => true,
        Some(c) => c == ' ',
    }
}

fn is_thematic_break(trimmed: &str) -> bool {
    let mut count = 0usize;
    let mut marker = None;
    for c in trimmed.chars() {
        match c {
            ' ' => {}
            '-' | '*' | '_' | '=' => {
                if let Some(existing) = marker {
                    if existing != c {
                        return false;
                    }
                } else {
                    marker = Some(c);
                }
                count += 1;
            }
            _ => return false,
        }
    }
    count >= 3
}

fn is_list_item(trimmed_start: &str) -> bool {
    let mut chars = trimmed_start.chars();
    match chars.next() {
        Some('-') | Some('*') | Some('+') => matches!(chars.next(), None | Some(' ')),
        Some(c) if c.is_ascii_digit() => {
            let mut digits = 1usize;
            let mut next = chars.next();
            while matches!(next, Some(d) if d.is_ascii_digit()) && digits < 9 {
                digits += 1;
                next = chars.next();
            }
            matches!(next, Some('.') | Some(')')) && matches!(chars.next(), None | Some(' '))
        }
        _ => false,
    }
}

fn is_table_row(trimmed: &str) -> bool {
    let pipes = trimmed.chars().filter(|c| *c == '|').count();
    pipes >= 2 || (pipes == 1 && trimmed.starts_with('|'))
}

#[cfg(test)]
mod tests {
    use super::{classify_line, ExcludedKind, FenceState, LineDecision};

    fn excluded(line: &str) -> Option<ExcludedKind> {
        classify_line(line, FenceState::None).excluded
    }

    #[test]
    fn classifies_every_exclusion_list_entry() {
        assert_eq!(excluded("plain prose line"), None);
        assert_eq!(excluded("## Heading"), Some(ExcludedKind::Heading));
        assert_eq!(excluded("#heading without space"), None);
        assert_eq!(excluded("-------"), Some(ExcludedKind::ThematicBreak));
        assert_eq!(excluded("===="), Some(ExcludedKind::ThematicBreak));
        assert_eq!(excluded("> quoted line"), Some(ExcludedKind::Quote));
        assert_eq!(excluded("- bullet"), Some(ExcludedKind::List));
        assert_eq!(excluded("  * nested bullet"), Some(ExcludedKind::List));
        assert_eq!(excluded("12. ordered item"), Some(ExcludedKind::List));
        assert_eq!(excluded("7) ordered item"), Some(ExcludedKind::List));
        assert_eq!(
            excluded("| alpha | beta | gamma |"),
            Some(ExcludedKind::Table)
        );
        assert_eq!(excluded("|---|---|"), Some(ExcludedKind::Table));
        assert_eq!(excluded("| single cell"), Some(ExcludedKind::Table));
        assert_eq!(excluded("a | b"), None);
    }

    #[test]
    fn tracks_fenced_code_blocks_across_lines() {
        let open = classify_line("```rust", FenceState::None);
        assert_eq!(open.excluded, Some(ExcludedKind::FenceDelimiter));
        assert_eq!(open.fence, FenceState::Backtick);

        let inside = classify_line("let value = compute(input);", open.fence);
        assert_eq!(inside.excluded, Some(ExcludedKind::FencedCode));
        assert_eq!(inside.fence, FenceState::Backtick);

        // Structure that would otherwise be excluded stays inside the fence.
        let heading_inside = classify_line("## not a heading here", open.fence);
        assert_eq!(heading_inside.excluded, Some(ExcludedKind::FencedCode));

        let close = classify_line("```", open.fence);
        assert_eq!(close.excluded, Some(ExcludedKind::FenceDelimiter));
        assert_eq!(close.fence, FenceState::None);
    }

    #[test]
    fn mismatched_fence_delimiter_stays_inside_the_block() {
        let decision = classify_line("~~~", FenceState::Backtick);
        assert_eq!(
            decision,
            LineDecision {
                excluded: Some(ExcludedKind::FencedCode),
                fence: FenceState::Backtick,
            }
        );
        assert_eq!(
            classify_line("rust", FenceState::Tilde).fence,
            FenceState::Tilde
        );
    }
}
