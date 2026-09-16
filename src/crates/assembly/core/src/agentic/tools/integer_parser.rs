use serde_json::Value;

/// Parse an unsigned integer from model-provided JSON, accepting integral
/// floating-point representations such as `100.0`.
pub fn parse_u64_value(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| {
                number.is_finite()
                    && *number >= 0.0
                    && number.fract() == 0.0
                    && *number <= u64::MAX as f64
            })
            .map(|number| number as u64)
    })
}

/// Parse a signed integer from model-provided JSON, accepting integral
/// floating-point representations such as `-2.0`.
pub fn parse_i64_value(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| {
                number.is_finite()
                    && number.fract() == 0.0
                    && *number >= i64::MIN as f64
                    && *number <= i64::MAX as f64
            })
            .map(|number| number as i64)
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_i64_value, parse_u64_value};
    use serde_json::json;

    #[test]
    fn accepts_integral_float_values() {
        assert_eq!(parse_u64_value(&json!(100.0)), Some(100));
        assert_eq!(parse_i64_value(&json!(-2.0)), Some(-2));
    }

    #[test]
    fn rejects_fractional_and_invalid_values() {
        assert_eq!(parse_u64_value(&json!(100.5)), None);
        assert_eq!(parse_u64_value(&json!(-1.0)), None);
        assert_eq!(parse_i64_value(&json!(1.5)), None);
        assert_eq!(parse_i64_value(&json!("2")), None);
    }
}
