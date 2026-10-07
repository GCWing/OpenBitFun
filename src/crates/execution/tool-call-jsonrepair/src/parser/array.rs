use crate::chars;

use super::JsonRepairer;
use super::Result;

impl JsonRepairer {
    pub(super) fn parse_array(&mut self) -> Result<bool> {
        if self.peek() != Some('[') {
            return Ok(false);
        }

        self.enter_container()?;
        self.output.push('[');
        let frame_start = self.output.len();
        self.pos += 1;
        self.parse_whitespace_and_comments();

        // Skip leading comma: [,1,2]
        if self.skip_char(',') {
            self.parse_whitespace_and_comments();
        }

        let mut initial = true;
        while !self.at_end() && self.peek() != Some(']') {
            if !initial {
                let processed_comma = self.parse_char(',');
                if !processed_comma {
                    // Missing comma.
                    self.insert_before_last_whitespace(",");
                }
            } else {
                initial = false;
            }

            if self
                .peek()
                .is_some_and(|c| c == '.' || c == '/' || c == '#' || chars::is_whitespace(c))
            {
                self.parse_skip_ellipsis();
            }

            let processed_value = self.parse_value()?;
            if !processed_value {
                // Trailing comma or truncated input.
                self.strip_trailing_comma(frame_start);
                break;
            }
        }

        if self.peek() == Some(']') {
            self.output.push(']');
            self.pos += 1;
        } else {
            // Missing closing array bracket.
            self.insert_before_last_whitespace("]");
        }
        self.leave_container();
        Ok(true)
    }
}
