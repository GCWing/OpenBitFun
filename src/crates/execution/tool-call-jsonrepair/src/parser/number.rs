use crate::chars;

use super::JsonRepairer;
use super::Result;

impl JsonRepairer {
    #[inline(always)]
    pub(super) fn parse_plus_number(&mut self) -> Result<bool> {
        if self.peek() != Some('+') {
            return Ok(false);
        }

        let token_start = self.pos;
        let output_start = self.output.len();
        self.pos += 1;

        if self.parse_number()? {
            return Ok(true);
        }

        self.pos = token_start;
        self.output.truncate(output_start);
        Ok(false)
    }

    #[inline(always)]
    pub(super) fn parse_number(&mut self) -> Result<bool> {
        let len = self.chars.len();
        let start = self.pos;
        let mut append_trailing_zero = false;
        let mut has_leading_dot = false;
        let mut has_invalid_leading_zero = false;
        // Exponent (`e`/`E`) is only valid after at least one integer or fraction
        // digit. Without this guard, plus-prefixed forms like `+e` / `+e1` (after
        // `parse_plus_number` strips `+`) would emit invalid JSON such as `e0`.
        let mut has_digit = false;

        if self.peek() == Some('-') {
            self.pos += 1;
            if self.at_end_of_number() {
                append_trailing_zero = true;
            } else if !(self.pos < len && chars::is_digit(self.chars[self.pos])
                || (self.pos + 1 < len
                    && self.chars[self.pos] == '.'
                    && chars::is_digit(self.chars[self.pos + 1])))
            {
                self.pos = start;
                return Ok(false);
            }
        }

        if !append_trailing_zero {
            if self.pos < len && self.chars[self.pos] == '.' {
                has_leading_dot = true;
                self.pos += 1;

                if self.pos >= len || !chars::is_digit(self.chars[self.pos]) {
                    self.pos = start;
                    return Ok(false);
                }

                has_digit = true;
                while self.pos < len && chars::is_digit(self.chars[self.pos]) {
                    self.pos += 1;
                }
            } else {
                let mut integer_digits = 0usize;
                let mut first_integer_digit = '\0';
                while self.pos < len {
                    let c = self.chars[self.pos];
                    if !chars::is_digit(c) {
                        break;
                    }

                    if integer_digits == 0 {
                        first_integer_digit = c;
                    } else if integer_digits == 1 && first_integer_digit == '0' {
                        has_invalid_leading_zero = true;
                    }
                    integer_digits += 1;
                    self.pos += 1;
                }
                if integer_digits > 0 {
                    has_digit = true;
                }

                if self.pos < len && self.chars[self.pos] == '.' {
                    self.pos += 1;
                    if self.at_end_of_number() {
                        append_trailing_zero = true;
                    } else if self.pos >= len || !chars::is_digit(self.chars[self.pos]) {
                        self.pos = start;
                        return Ok(false);
                    } else {
                        has_digit = true;
                        while self.pos < len && chars::is_digit(self.chars[self.pos]) {
                            self.pos += 1;
                        }
                    }
                }
            }

            if !append_trailing_zero
                && has_digit
                && self.pos < len
                && matches!(self.chars[self.pos], 'e' | 'E')
            {
                self.pos += 1;
                if self.pos < len && matches!(self.chars[self.pos], '-' | '+') {
                    self.pos += 1;
                }
                if self.at_end_of_number() {
                    append_trailing_zero = true;
                } else if self.pos >= len || !chars::is_digit(self.chars[self.pos]) {
                    self.pos = start;
                    return Ok(false);
                } else {
                    while self.pos < len && chars::is_digit(self.chars[self.pos]) {
                        self.pos += 1;
                    }
                }
            }
        }

        // If number is followed by non-delimiter text, let unquoted string parser handle it.
        if !append_trailing_zero && !self.at_end_of_number() {
            self.pos = start;
            return Ok(false);
        }

        if self.pos > start {
            self.push_number_to_output(
                start,
                self.pos,
                append_trailing_zero,
                has_invalid_leading_zero,
                has_leading_dot,
            );
            return Ok(true);
        }

        Ok(false)
    }

    #[inline(always)]
    fn push_number_to_output(
        &mut self,
        start: usize,
        end: usize,
        append_trailing_zero: bool,
        has_invalid_leading_zero: bool,
        has_leading_dot: bool,
    ) {
        if has_invalid_leading_zero {
            self.output.push('"');
            self.push_slice_to_output(start, end);
            if append_trailing_zero {
                self.output.push('0');
            }
            self.output.push('"');
            return;
        }

        if has_leading_dot {
            if self.chars[start] == '-' {
                self.output.push('-');
                self.output.push('0');
                self.output.push('.');
                self.push_slice_to_output(start + 2, end);
            } else {
                self.output.push('0');
                self.output.push('.');
                self.push_slice_to_output(start + 1, end);
            }
        } else {
            self.push_slice_to_output(start, end);
        }
        if append_trailing_zero {
            self.output.push('0');
        }
    }

    #[inline(always)]
    fn at_end_of_number(&self) -> bool {
        match self.peek() {
            None => true,
            Some(c) => chars::is_delimiter(c) || chars::is_whitespace(c),
        }
    }
}
