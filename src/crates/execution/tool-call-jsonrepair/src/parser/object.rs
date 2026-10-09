use crate::chars;
use crate::error::JsonRepairErrorKind;

use super::JsonRepairer;
use super::Result;

impl JsonRepairer {
    pub(super) fn parse_object(&mut self) -> Result<bool> {
        if self.peek() != Some('{') {
            return Ok(false);
        }

        self.enter_container()?;
        self.output.push('{');
        let frame_start = self.output.len();
        self.pos += 1;
        self.parse_whitespace_and_comments();

        // Skip leading comma: {, "a": 1}
        if self.skip_char(',') {
            self.parse_whitespace_and_comments();
        }

        let mut initial = true;
        while !self.at_end() && self.peek() != Some('}') {
            if !initial {
                let processed_comma = self.parse_char(',');
                if !processed_comma {
                    // Missing comma.
                    self.insert_before_last_whitespace(",");
                }
                self.parse_whitespace_and_comments();
            } else {
                initial = false;
            }

            if self.peek() == Some('.') {
                self.parse_skip_ellipsis();
            }

            let processed_key = self.parse_object_key()?;
            if !processed_key {
                let near_end = self.at_end()
                    || matches!(self.peek(), Some('}') | Some('{') | Some(']') | Some('['));
                if near_end {
                    // Trailing comma.
                    self.strip_trailing_comma(frame_start);
                } else {
                    return Err(self.error_kind(
                        "Object key expected",
                        JsonRepairErrorKind::ObjectKeyExpected,
                    ));
                }
                break;
            }

            self.parse_whitespace_and_comments();
            let processed_colon = if self.parse_char(':') {
                true
            } else if self.peek() == Some('=') {
                // Non-standard, commonly seen in JS-ish objects.
                self.output.push(':');
                self.pos += 1;
                true
            } else {
                false
            };

            let truncated = self.at_end();
            if !processed_colon {
                if self.peek().is_some_and(chars::is_start_of_value) || truncated {
                    // Missing colon.
                    self.insert_before_last_whitespace(":");
                } else {
                    return Err(
                        self.error_kind("Colon expected", JsonRepairErrorKind::ColonExpected)
                    );
                }
            }

            let processed_value = self.parse_value()?;
            if !processed_value {
                if processed_colon || truncated {
                    // Missing object value.
                    self.output.push_str("null");
                } else {
                    return Err(
                        self.error_kind("Colon expected", JsonRepairErrorKind::ColonExpected)
                    );
                }
            }
        }

        if self.peek() == Some('}') {
            self.output.push('}');
            self.pos += 1;
        } else {
            // Missing closing brace.
            self.insert_before_last_whitespace("}");
        }

        self.leave_container();
        Ok(true)
    }

    fn parse_object_key(&mut self) -> Result<bool> {
        if self.parse_string()? {
            return Ok(true);
        }
        self.parse_unquoted_string(true)
    }

    /// Parse and skip `...` (ellipsis), returning true if found.
    pub(super) fn parse_skip_ellipsis(&mut self) -> bool {
        let mut processed = false;
        loop {
            self.parse_whitespace_and_comments();
            if self.peek() != Some('.') || !self.matches_at(self.pos, "...") {
                break;
            }

            processed = true;
            self.pos += 3;
            self.parse_whitespace_and_comments();
            if self.peek() == Some(',') {
                self.pos += 1;
            }
        }
        processed
    }
}
