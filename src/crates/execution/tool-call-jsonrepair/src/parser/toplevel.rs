use crate::chars;
use crate::error::JsonRepairErrorKind;

use super::JsonRepairer;
use super::Result;

impl JsonRepairer {
    pub(crate) fn repair(mut self) -> Result<String> {
        self.parse_markdown_wrapped_open();

        let processed = self.parse_value()?;
        if !processed {
            if self.at_end() {
                return Err(self.error_kind(
                    "Unexpected end of json string",
                    JsonRepairErrorKind::UnexpectedEnd,
                ));
            }
            return Err(self.error_char_kind(
                "Unexpected character",
                JsonRepairErrorKind::UnexpectedCharacter,
            ));
        }

        self.parse_markdown_wrapped_close();

        let processed_comma = self.parse_char(',');
        if processed_comma {
            self.parse_whitespace_and_comments();
        }

        if self.peek().is_some_and(chars::is_start_of_value)
            && self.output_ends_with_comma_or_newline()
        {
            // Newline/comma delimited JSON on root level.
            if !processed_comma {
                self.insert_before_last_whitespace(",");
            }
            self.parse_ndjson()?;
        } else if processed_comma {
            // Remove trailing comma after a single root value.
            self.strip_trailing_comma(0);
        }

        // Repair redundant closing brackets at the root level.
        while matches!(self.peek(), Some('}') | Some(']')) {
            self.pos += 1;
            self.parse_whitespace_and_comments();
        }

        // Optional trailing semicolons.
        while self.peek() == Some(';') {
            self.pos += 1;
            self.parse_whitespace_and_comments();
        }

        if self.at_end() {
            return Ok(self.output);
        }

        Err(self.error_char_kind(
            "Unexpected character",
            JsonRepairErrorKind::UnexpectedCharacter,
        ))
    }

    fn parse_ndjson(&mut self) -> Result<()> {
        let mut initial = true;
        let mut processed_value = true;
        // repair() has already inserted or consumed the separator before the
        // first additional value.
        let mut pending_comma = self.output.rfind(',');
        while processed_value {
            if !initial {
                let processed_comma = self.parse_char(',');
                if !processed_comma {
                    self.insert_before_last_whitespace(",");
                }
                pending_comma = self.output.rfind(',');
            } else {
                initial = false;
            }

            processed_value = self.parse_value()?;
        }

        if !processed_value {
            if let Some(index) = pending_comma {
                self.output.remove(index);
            }
        }

        self.output.insert_str(0, "[\n");
        self.output.push_str("\n]");
        Ok(())
    }
}
