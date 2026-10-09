use openbitfun_tool_call_jsonrepair::jsonrepair;

// ── Helpers ──────────────────────────────────────────────────

const DEEP_STACK_TEST_STACK_SIZE: usize = 16 * 1024 * 1024;

fn ok(input: &str, expected: &str) {
    let result = jsonrepair(input).unwrap_or_else(|e| panic!("repair failed for {input:?}: {e}"));
    assert_eq!(result, expected, "input: {input:?}");
}

fn err(input: &str) {
    assert!(
        jsonrepair(input).is_err(),
        "expected error for {input:?}, got: {:?}",
        jsonrepair(input)
    );
}

fn err_exact(input: &str, message: &str, position: usize) {
    let err = jsonrepair(input).expect_err(&format!("expected precise error for {input:?}"));
    assert_eq!(err.message, message, "input: {input:?}");
    assert_eq!(err.position, position, "input: {input:?}");
    assert!(err.line > 0, "expected line info for {input:?}");
    assert!(err.column > 0, "expected column info for {input:?}");
}

fn run_with_large_stack<F>(f: F)
where
    F: FnOnce() + Send + 'static,
{
    let handle = std::thread::Builder::new()
        .name("deep-stack-regression".to_string())
        .stack_size(DEEP_STACK_TEST_STACK_SIZE)
        .spawn(f)
        .unwrap_or_else(|e| panic!("failed to spawn deep-stack test thread: {e}"));

    if let Err(payload) = handle.join() {
        std::panic::resume_unwind(payload);
    }
}

// ── 1. Valid JSON (pass-through, whitespace preserved) ───────

#[test]
fn valid_object() {
    ok(r#"{"a":2}"#, r#"{"a":2}"#);
}

#[test]
fn valid_object_with_spaces() {
    ok(r#"{"a": 2}"#, r#"{"a": 2}"#);
}

#[test]
fn valid_array() {
    ok("[1,2,3]", "[1,2,3]");
}

#[test]
fn valid_array_with_spaces() {
    ok("[ 1 , 2 , 3 ]", "[ 1 , 2 , 3 ]");
}

#[test]
fn valid_string() {
    ok(r#""hello""#, r#""hello""#);
}

#[test]
fn valid_number() {
    ok("42", "42");
}

#[test]
fn valid_negative_float() {
    ok("-3.14", "-3.14");
}

#[test]
fn valid_keywords() {
    ok("true", "true");
    ok("false", "false");
    ok("null", "null");
}

#[test]
fn valid_nested() {
    ok(
        r#"{"a":[1,{"b":true}],"c":null}"#,
        r#"{"a":[1,{"b":true}],"c":null}"#,
    );
}

#[test]
fn valid_empty_object_with_spaces() {
    ok("{  }", "{  }");
}

// ── 2. Quote repairs (whitespace preserved) ──────────────────

#[test]
fn single_quotes_to_double() {
    ok("{'name': 'John'}", r#"{"name": "John"}"#);
}

#[test]
fn single_quotes_value() {
    ok("'hello'", r#""hello""#);
}

#[test]
fn curly_double_quotes() {
    ok("\u{201C}hello\u{201D}", r#""hello""#);
}

#[test]
fn curly_single_quotes() {
    ok("\u{2018}hello\u{2019}", r#""hello""#);
}

#[test]
fn backtick_quotes() {
    ok("`hello`", r#""hello""#);
}

#[test]
fn unquoted_keys() {
    ok(r#"{name: "John"}"#, r#"{"name": "John"}"#);
}

// ── 3. String repairs ────────────────────────────────────────

#[test]
fn escape_unescaped_newline_in_string() {
    ok("\"hello\nworld\"", r#""hello\nworld""#);
}

#[test]
fn escape_unescaped_tab_in_string() {
    ok("\"hello\tworld\"", r#""hello\tworld""#);
}

#[test]
fn invalid_escape_sequence() {
    ok(r#""hello\a""#, r#""helloa""#);
}

#[test]
fn string_concatenation() {
    ok(r#""hello" + " " + "world""#, r#""hello world""#);
}

#[test]
fn incomplete_unicode_escape() {
    err(r#""\u00""#);
}

// ── 4. Missing commas (whitespace preserved) ─────────────────

#[test]
fn missing_comma_between_object_properties() {
    ok(r#"{"a": 1 "b": 2}"#, r#"{"a": 1, "b": 2}"#);
}

#[test]
fn missing_comma_between_array_elements() {
    ok("[1 2 3]", "[1, 2, 3]");
}

// ── 5. Trailing commas (comma removed, whitespace preserved) ─

#[test]
fn trailing_comma_in_object() {
    ok(r#"{"a": 1, "b": 2,}"#, r#"{"a": 1, "b": 2}"#);
}

#[test]
fn trailing_comma_in_array() {
    ok("[1, 2, 3,]", "[1, 2, 3]");
}

// ── 6. Leading commas ────────────────────────────────────────

#[test]
fn leading_comma_in_object() {
    ok(r#"{,"a": 1}"#, r#"{"a": 1}"#);
}

#[test]
fn leading_comma_in_array() {
    ok("[,1,2]", "[1,2]");
}

// ── 7. Missing colon ────────────────────────────────────────

#[test]
fn missing_colon_no_space() {
    ok(r#"{"a"1}"#, r#"{"a":1}"#);
}

#[test]
fn missing_colon_with_space() {
    ok(r#"{"a" 1}"#, r#"{"a": 1}"#);
}

#[test]
fn equals_as_colon() {
    ok(r#"{"a" = 1}"#, r#"{"a" : 1}"#);
}

// ── 8. Missing value ────────────────────────────────────────

#[test]
fn missing_value_in_object() {
    ok(r#"{"a":}"#, r#"{"a":null}"#);
}

// ── 9. Comments (removed, surrounding whitespace preserved) ──

#[test]
fn line_comment() {
    ok("{\n// comment\n\"a\": 1\n}", "{\n\n\"a\": 1\n}");
}

#[test]
fn block_comment() {
    ok("{/* comment */\"a\": 1}", "{\"a\": 1}");
}

#[test]
fn hash_comment() {
    ok("{\n# comment\n\"a\": 1\n}", "{\n\n\"a\": 1\n}");
}

// ── 10. Python keywords ──────────────────────────────────────

#[test]
fn python_true() {
    ok("True", "true");
}

#[test]
fn python_false() {
    ok("False", "false");
}

#[test]
fn python_none() {
    ok("None", "null");
}

#[test]
fn python_keywords_in_object() {
    ok(
        r#"{"flag": True, "value": None}"#,
        r#"{"flag": true, "value": null}"#,
    );
}

#[test]
fn case_insensitive_keywords() {
    ok("TRUE", "true");
    ok("FALSE", "false");
    ok("NULL", "null");
    ok("undefined", "null");
}

// ── 11. JavaScript keywords ──────────────────────────────────

#[test]
fn js_undefined() {
    ok("undefined", "null");
}

#[test]
fn js_nan() {
    ok("NaN", "null");
}

#[test]
fn js_infinity() {
    ok("Infinity", "null");
}

#[test]
fn signed_non_finite_numbers() {
    ok("-Infinity", "null");
    ok("+Infinity", "null");
    ok("-NaN", "null");
    ok("+NaN", "null");
    ok("- Infinity", "null");
    ok("+\tInfinity", "null");
    ok("-\u{00A0}Infinity", "null");
    ok(r#"{"x":-Infinity,"y":+NaN}"#, r#"{"x":null,"y":null}"#);
    ok(r#"{"x":- Infinity}"#, r#"{"x":null}"#);
    ok("{\"x\":-\u{00A0}Infinity}", r#"{"x":null}"#);
    ok("-Infinity;", "null");
    ok("+NaN;", "null");
}

// ── 12. Truncated JSON ───────────────────────────────────────

#[test]
fn truncated_object() {
    ok(r#"{"a": 1, "b": 2"#, r#"{"a": 1, "b": 2}"#);
}

#[test]
fn truncated_array() {
    ok("[1, 2, 3", "[1, 2, 3]");
}

#[test]
fn truncated_string() {
    ok(r#""hello"#, r#""hello""#);
}

#[test]
fn truncated_nested() {
    ok(r#"{"a": [1, 2, {"b": 3"#, r#"{"a": [1, 2, {"b": 3}]}"#);
}

#[test]
fn llm_stream_prefix_ending_at_first_url_slash() {
    ok(
        r##"{"content":"# Heading\nhttps:/"##,
        r##"{"content":"# Heading\nhttps:/"}"##,
    );
}

#[test]
fn llm_stream_string_prefixes_remain_repairable() {
    let full =
        r##"{"content":"# Heading\nhttps://example.com/path","items":[{"id":1,"name":"Ada"}]}"##;
    for end in full
        .char_indices()
        .map(|(index, _)| index)
        .skip(1)
        .chain(std::iter::once(full.len()))
    {
        let prefix = &full[..end];
        let repaired = openbitfun_tool_call_jsonrepair::jsonrepair(prefix)
            .unwrap_or_else(|error| panic!("prefix {prefix:?} failed: {error}"));
        serde_json::from_str::<serde_json::Value>(&repaired)
            .unwrap_or_else(|error| panic!("prefix {prefix:?} produced invalid JSON: {error}"));
    }
}

#[test]
fn unsupported_whitespace_only_array_value_does_not_loop() {
    for input in ["[\u{000C}", "[1,\u{000C}"] {
        assert!(
            jsonrepair(input).is_err(),
            "input {input:?} must return an error"
        );
    }
}

#[test]
fn root_list_trailing_comma_does_not_remove_earlier_separator() {
    let repaired = jsonrepair("R ,[{[").unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&repaired).unwrap();
    assert_eq!(parsed.as_array().map(Vec::len), Some(2));
}

#[test]
fn invalid_escape_before_control_character_is_escaped_in_output() {
    ok("'z\\\u{0010}'", r#""z\u0010""#);
}

#[test]
fn isolated_unicode_surrogates_return_invalid_unicode_error() {
    use openbitfun_tool_call_jsonrepair::JsonRepairErrorKind;

    for input in [r#""\udfff""#, r#""\ud83d""#, r#""\ud83d\u0041""#] {
        let error = jsonrepair(input).expect_err("isolated surrogate must fail");
        assert_eq!(error.kind, JsonRepairErrorKind::InvalidUnicode);
    }
    ok(r#""\ud83d\ude00""#, r#""\ud83d\ude00""#);
}

#[test]
fn escaped_comma_does_not_cause_recursive_string_retry() {
    let input = "'\\,'?";
    if let Ok(repaired) = jsonrepair(input) {
        serde_json::from_str::<serde_json::Value>(&repaired).unwrap();
    }
}

#[test]
fn empty_fenced_root_value_does_not_leave_trailing_comma() {
    let repaired = jsonrepair("\0\n``````").unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&repaired).unwrap();
    assert_eq!(parsed.as_array().map(Vec::len), Some(1));
}

// ── 13. Markdown code fences ─────────────────────────────────

#[test]
fn markdown_json_fence() {
    ok("```json\n{\"a\": 1}\n```", "\n{\"a\": 1}\n");
}

#[test]
fn markdown_plain_fence() {
    ok("```\n{\"a\": 1}\n```", "\n{\"a\": 1}\n");
}

// ── 14. Numbers ──────────────────────────────────────────────

#[test]
fn leading_zeros_as_string() {
    ok("0789", r#""0789""#);
}

#[test]
fn trailing_dot() {
    ok("2.", "2.0");
}

#[test]
fn truncated_exponent() {
    ok("2e", "2e0");
}

#[test]
fn number_with_exponent() {
    ok("1e5", "1e5");
}

#[test]
fn negative_number() {
    ok("-42", "-42");
}

#[test]
fn plus_prefixed_numbers() {
    ok("+42", "42");
    ok("[+1,+2,+3]", "[1,2,3]");
    ok("{value:+.5}", "{\"value\":0.5}");
}

#[test]
fn leading_dot_numbers() {
    ok(".5", "0.5");
    ok("-.5", "-0.5");
    ok("[.5e2, -.5e-1]", "[0.5e2, -0.5e-1]");
    ok("{value: .25}", "{\"value\": 0.25}");
}

// ── 15. MongoDB constructors ─────────────────────────────────

#[test]
fn mongodb_object_id() {
    ok(r#"{"_id": ObjectId("123abc")}"#, r#"{"_id": "123abc"}"#);
}

#[test]
fn mongodb_number_long() {
    ok(r#"{"count": NumberLong("42")}"#, r#"{"count": "42"}"#);
}

#[test]
fn mongodb_new_wrapper_variants() {
    ok(r#"{"_id": new ObjectId("123abc")}"#, r#"{"_id": "123abc"}"#);
    ok(r#"{"_id": NEW ObjectId("123abc")}"#, r#"{"_id": "123abc"}"#);
    ok(r#"{"count": new NumberLong("42")}"#, r#"{"count": "42"}"#);
    ok(r#"{"count": NEW numberlong("42")}"#, r#"{"count": "42"}"#);
    ok(
        r#"{"created": isodate("2020-01-01")}"#,
        r#"{"created": "2020-01-01"}"#,
    );
    ok(r#"{"n": new NumberInt()}"#, r#"{"n": null}"#);
}

// ── 16. JSONP ────────────────────────────────────────────────

#[test]
fn jsonp_callback() {
    ok(r#"callback({"a": 1})"#, r#"{"a": 1}"#);
}

#[test]
fn trailing_semicolon() {
    ok(r#"{"a": 1};"#, r#"{"a": 1}"#);
    ok("1;", "1");
    ok("2e+;", "2e+0");
}

// ── 17. Ellipsis ─────────────────────────────────────────────

#[test]
fn ellipsis_in_array() {
    ok("[1,2,3,...]", "[1,2,3]");
}

#[test]
fn ellipsis_in_array_with_spaces() {
    // Comma before ellipsis stripped, ellipsis consumed, trailing whitespace preserved
    ok("[1, 2, 3, ... ]", "[1, 2, 3  ]");
}

#[test]
fn ellipsis_in_object() {
    // Comma before ellipsis stripped, trailing space before } preserved
    ok(r#"{"a": 1, ...}"#, r#"{"a": 1 }"#);
}

#[test]
fn many_ellipsis_in_array() {
    let input = format!("[{}1]", "...,".repeat(2048));
    ok(&input, "[1]");
}

// ── 18. BOM handling ─────────────────────────────────────────

#[test]
fn bom_prefix() {
    ok("\u{FEFF}{\"a\": 1}", "{\"a\": 1}");
}

// ── 19. Special whitespace ───────────────────────────────────

#[test]
fn non_breaking_space() {
    // Special whitespace is normalized to a regular space outside strings.
    ok("{\u{00A0}\"a\": 1}", "{ \"a\": 1}");
}

// ── 20. NDJSON ───────────────────────────────────────────────

#[test]
fn ndjson_two_objects() {
    ok("{\"a\":1}\n{\"b\":2}", "[\n{\"a\":1},\n{\"b\":2}\n]");
}

// ── 21. Error cases ──────────────────────────────────────────

#[test]
fn empty_input() {
    err("");
}

#[test]
fn whitespace_only() {
    err("   ");
}

// ── 22. Complex / mixed repairs ──────────────────────────────

#[test]
fn mixed_repairs() {
    ok(
        "{'name': 'John', age: 30, 'active': True,}",
        r#"{"name": "John", "age": 30, "active": true}"#,
    );
}

#[test]
fn deeply_nested_with_issues() {
    ok(
        "{a: [1, {b: 'hello' c: True},]}",
        r#"{"a": [1, {"b": "hello", "c": true}]}"#,
    );
}

#[test]
fn object_with_comments_and_trailing_commas() {
    ok(
        "{\n  // name\n  \"name\": \"John\",\n  /* age */\n  \"age\": 30,\n}",
        "{\n  \n  \"name\": \"John\",\n  \n  \"age\": 30\n}",
    );
}

// ── 23. JS parity gaps (newly added) ──────────────────────────

#[test]
fn unquoted_url_as_string() {
    ok("https://www.bible.com/", "\"https://www.bible.com/\"");
    ok(
        "{url:https://www.bible.com/}",
        r#"{"url":"https://www.bible.com/"}"#,
    );
    ok(
        "[https://www.bible.com/,2]",
        r#"["https://www.bible.com/",2]"#,
    );
}

#[test]
fn url_with_missing_end_quote() {
    ok("\"https://www.bible.com/", "\"https://www.bible.com/\"");
    ok(
        r#"{"url":"https://www.bible.com/}"#,
        r#"{"url":"https://www.bible.com/"}"#,
    );
    ok(
        r#"["https://www.bible.com/,2]"#,
        r#"["https://www.bible.com/",2]"#,
    );
}

#[test]
fn missing_start_quote() {
    ok(r#"abc""#, r#""abc""#);
    ok(r#"[a","b"]"#, r#"["a","b"]"#);
    ok(r#"{"a":foo","b":"bar"}"#, r#"{"a":"foo","b":"bar"}"#);
}

#[test]
fn unescaped_double_quotes_in_string() {
    ok(
        r#""The TV has a 24" screen""#,
        r#""The TV has a 24\" screen""#,
    );
    ok(
        r#"{"key": "apple "bee" carrot"}"#,
        r#"{"key": "apple \"bee\" carrot"}"#,
    );
    ok(r#"["a" 2]"#, r#"["a", 2]"#);
}

#[test]
fn replace_special_whitespace_outside_strings() {
    ok("{\"a\":\u{2000}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\u{200B}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\"foo\u{00A0}bar\"}", "{\"a\":\"foo\u{00A0}bar\"}");
}

#[test]
fn mixed_mismatched_brackets() {
    ok("[}", "[]");
    ok("{]", "{}");
    ok("[2,}", "[2]");
    ok("{\"a\":2]", "{\"a\":2}");
}

// ── 24. More JS parity coverage ───────────────────────────────

#[test]
fn comments_after_string_delimiter() {
    ok(r#"["a"/* foo */]"#, r#"["a"]"#);
    ok(r#"["(a)"/* foo */]"#, r#"["(a)"]"#);
    ok(r#"["a]"/* foo */]"#, r#"["a]"]"#);
    ok(r#"{"a":"b"/* foo */}"#, r#"{"a":"b"}"#);
}

#[test]
fn jsonp_variants() {
    ok("callback_123({});", "{}");
    ok("callback_123([]);", "[]");
    ok("CALLBACK_123({});", "{}");
    ok("callback({}", "{}");
    ok("/* foo bar */ callback_123 ({})", " {}");
    ok("/* foo bar */ callback_123 (  {}  )", "   {}  ");
}

#[test]
fn markdown_fenced_variants() {
    ok("```\n{\"a\":\"b\"}\n```", "\n{\"a\":\"b\"}\n");
    ok("```json\n{\"a\":\"b\"}\n```", "\n{\"a\":\"b\"}\n");
    ok("```{\"a\":\"b\"}```", "{\"a\":\"b\"}");
    ok(
        "\n ```json\n{\"a\":\"b\"}\n```\n  ",
        "\n \n{\"a\":\"b\"}\n\n  ",
    );
}

#[test]
fn escaped_string_wrapper_variants() {
    ok("\\\"hello world\\\"", r#""hello world""#);
    ok("\\\"hello world\\", r#""hello world""#);
}

#[test]
fn trailing_comma_root_variants() {
    ok("4,", "4");
    ok("4 ,", "4 ");
    ok("4 , ", "4  ");
    ok("{\"a\":2},", "{\"a\":2}");
    ok("[1,2,3],", "[1,2,3]");
}

#[test]
fn missing_closing_bracket_variants() {
    ok("[", "[]");
    ok("[\"foo\"", "[\"foo\"]");
    ok("{\"foo\":\"bar\"", "{\"foo\":\"bar\"}");
    ok("[{\"b\":2]", "[{\"b\":2}]");
}

#[test]
fn redundant_closing_bracket_variants() {
    ok("{\"a\": 1}}", "{\"a\": 1}");
    ok("{\"a\": 1}}]}", "{\"a\": 1}");
    ok("{}}", "{}");
}

#[test]
fn parse_unquoted_strings_more() {
    ok("hello world", "\"hello world\"");
    ok("She said: no way", "\"She said: no way\"");
    ok(
        "[\"This is C(2)\", This is F(3)]",
        "[\"This is C(2)\", \"This is F(3)\"]",
    );
}

#[test]
fn invalid_numbers_as_string() {
    ok("0.0.1", "\"0.0.1\"");
    ok("234..5", "\"234..5\"");
    ok("2e3.4", "\"2e3.4\"");
    ok(
        "746de9ad-d4ff-4c66-97d7-00a92ad46967",
        "\"746de9ad-d4ff-4c66-97d7-00a92ad46967\"",
    );
}

#[test]
fn regex_repairs() {
    ok(
        "{regex: /standalone-styles.css/}",
        "{\"regex\": \"/standalone-styles.css/\"}",
    );
    ok("/[a-z]_/", "\"/[a-z]_/\"");
    ok(
        "/foo\"; console.log(-1); \"/",
        "\"/foo\\\"; console.log(-1); \\\"/\"",
    );
    ok("/\t/", r#""/\t/""#);
    ok("/\x08/", r#""/\b/""#);
    ok(r"/\\z/", r#""/\\\\z/""#);
}

#[test]
fn special_quotes_behavior() {
    ok("\"Rounded “ quote\"", "\"Rounded “ quote\"");
    ok("'Rounded “ quote'", "\"Rounded “ quote\"");
    ok("'Double \\\" quote'", "\"Double \\\" quote\"");
    ok("\u{2018}foo\u{2019}", "\"foo\"");
    ok("\u{201C}foo\u{201D}", "\"foo\"");
    ok("\u{0060}foo\u{00B4}", "\"foo\"");
}

#[test]
fn numbers_at_end_variants() {
    ok("{\"a\":2e-}", "{\"a\":2e-0}");
    ok("{\"a\":-}", "{\"a\":-0}");
    ok("[2e,]", "[2e0]");
    ok("[2e ", "[2e0] ");
    ok("[-,]", "[-0]");
}

#[test]
fn comma_separated_root_values() {
    ok("1,2,3", "[\n1,2,3\n]");
    ok("1,2,3,", "[\n1,2,3\n]");
    ok("a,b", "[\n\"a\",\"b\"\n]");
    ok("1\n2\n3", "[\n1,\n2,\n3\n]");
}

// ── 25. Markdown Wrapper Variants ─────────────────────────────

#[test]
fn invalid_markdown_fenced_wrappers() {
    ok("[```\n{\"a\":\"b\"}\n```]", "\n{\"a\":\"b\"}\n");
    ok("[```json\n{\"a\":\"b\"}\n```]", "\n{\"a\":\"b\"}\n");
    ok("{```\n{\"a\":\"b\"}\n```}", "\n{\"a\":\"b\"}\n");
    ok("{```json\n{\"a\":\"b\"}\n```}", "\n{\"a\":\"b\"}\n");
}

// ── 26. Non-repairable Should Error ───────────────────────────

#[test]
fn non_repairable_cases_should_error() {
    err_exact("", "Unexpected end of json string", 0);
    err_exact("{\"a\",", "Colon expected", 4);
    err_exact("{:2}", "Object key expected", 1);
    err_exact("{\"a\":2}{}", "Unexpected character \"{\"", 7);
    err_exact("{\"a\" ]", "Colon expected", 5);
    err_exact("{\"a\":2}foo", "Unexpected character \"f\"", 7);
    err_exact("foo [", "Unexpected character \"[\"", 4);
    err_exact("\"\\u26\"", "Invalid unicode character \"\\u26\"\"", 1);
    err_exact("\"\\uZ000\"", "Invalid unicode character \"\\uZ000\"", 1);
    err_exact("\"\\uZ000", "Invalid unicode character \"\\uZ000\"", 1);
    err_exact("\"abc\u{0000}\"", "Invalid character '\\0'", 4);
    err_exact("\"abc\u{001F}\"", "Invalid character '\\u{1f}'", 4);
    err_exact("callback {}", "Unexpected character \"{\"", 9);
}

// ── 27. Extended JS parity batch ──────────────────────────────

#[test]
fn delimiter_strings_and_unicode() {
    ok("\"\"", "\"\"");
    ok("\"[\"", "\"[\"");
    ok("\"]\"", "\"]\"");
    ok("\"{\"", "\"{\"");
    ok("\"}\"", "\"}\"");
    ok("\":\"", "\":\"");
    ok("\",\"", "\",\"");

    ok("\"★\"", "\"★\"");
    ok("\"😀\"", "\"😀\"");
    ok("\"йнформация\"", "\"йнформация\"");
    ok("{\"★\":true}", "{\"★\":true}");
    ok("{\"😀\":true}", "{\"😀\":true}");
}

#[test]
fn mongodb_extensive_document() {
    let mongo_document = "{\n\
   \"_id\" : ObjectId(\"123\"),\n\
   \"isoDate\" : ISODate(\"2012-12-19T06:01:17.171Z\"),\n\
   \"regularNumber\" : 67,\n\
   \"long\" : NumberLong(\"2\"),\n\
   \"long2\" : NumberLong(2),\n\
   \"int\" : NumberInt(\"3\"),\n\
   \"int2\" : NumberInt(3),\n\
   \"decimal\" : NumberDecimal(\"4\"),\n\
   \"decimal2\" : NumberDecimal(4)\n\
}";

    let expected = "{\n\
   \"_id\" : \"123\",\n\
   \"isoDate\" : \"2012-12-19T06:01:17.171Z\",\n\
   \"regularNumber\" : 67,\n\
   \"long\" : \"2\",\n\
   \"long2\" : 2,\n\
   \"int\" : \"3\",\n\
   \"int2\" : 3,\n\
   \"decimal\" : \"4\",\n\
   \"decimal2\" : 4\n\
}";

    ok(mongo_document, expected);
}

#[test]
fn unknown_symbols_to_string_more() {
    ok("[1,foo,4]", "[1,\"foo\",4]");
    ok("{foo: bar}", "{\"foo\": \"bar\"}");
    ok("foo 2 bar", "\"foo 2 bar\"");
    ok("{greeting: hello world}", "{\"greeting\": \"hello world\"}");
    ok(
        "{greeting: hello world\nnext: \"line\"}",
        "{\"greeting\": \"hello world\",\n\"next\": \"line\"}",
    );
    ok(
        "{greeting: hello world!}",
        "{\"greeting\": \"hello world!\"}",
    );
}

#[test]
fn missing_comma_object_properties_more() {
    ok("{\"a\":2\n\"b\":3\n}", "{\"a\":2,\n\"b\":3\n}");
    ok("{\"a\":2\n\"b\":3\nc:4}", "{\"a\":2,\n\"b\":3,\n\"c\":4}");
    ok(
        "{\n  \"firstName\": \"John\"\n  lastName: Smith",
        "{\n  \"firstName\": \"John\",\n  \"lastName\": \"Smith\"}",
    );
    ok(
        "{\n  \"firstName\": \"John\" /* comment */ \n  lastName: Smith",
        "{\n  \"firstName\": \"John\",  \n  \"lastName\": \"Smith\"}",
    );
    ok(
        "{\n  \"firstName\": \"John\"\n  ,  lastName: Smith",
        "{\n  \"firstName\": \"John\"\n  ,  \"lastName\": \"Smith\"}",
    );
}

#[test]
fn mixed_missing_comma_quotes_brackets() {
    ok(
        "{\"array\": [\na\nb\n]}",
        "{\"array\": [\n\"a\",\n\"b\"\n]}",
    );
    ok("1\n2", "[\n1,\n2\n]");
    ok("[a,b\nc]", "[\"a\",\"b\",\n\"c\"]");
}

#[test]
fn ndjson_with_comments_and_commas() {
    let text1 = "/* 1 */\n{}\n\n/* 2 */\n{}\n\n/* 3 */\n{}\n";
    let text2 = "/* 1 */\n{},\n\n/* 2 */\n{},\n\n/* 3 */\n{}\n";
    let text3 = "/* 1 */\n{},\n\n/* 2 */\n{},\n\n/* 3 */\n{},\n";
    let expected = "[\n\n{},\n\n\n{},\n\n\n{}\n\n]";

    ok(text1, expected);
    ok(text2, expected);
    ok(text3, expected);
}

#[test]
fn leading_zero_more_cases() {
    ok("000789", "\"000789\"");
    ok("001.2", "\"001.2\"");
    ok("002e3", "\"002e3\"");
    ok("-01", "\"-01\"");
    ok("-00", "\"-00\"");
    ok("00.", "\"00.0\"");
    ok("00e", "\"00e0\"");
    ok("[0789]", "[\"0789\"]");
    ok("[-01]", "[\"-01\"]");
    ok("{value:0789}", "{\"value\":\"0789\"}");
    ok("{value:-01}", "{\"value\":\"-01\"}");
}

#[test]
fn comma_and_comment_variants() {
    ok("[/* a */,/* b */1,2,3]", "[1,2,3]");
    ok(
        "{/* a */,/* b */\"message\": \"hi\"}",
        "{\"message\": \"hi\"}",
    );
    ok("[1,2,3,\n]", "[1,2,3\n]");
    ok("[1,2,3,  \n  ]", "[1,2,3  \n  ]");
    ok("{\"a\":2  ,  }", "{\"a\":2    }");
    ok("{\"a\":2  , \n }", "{\"a\":2   \n }");
    ok("{},", "{}");
}

// ── 28. String Edge Cases ─────────────────────────────────────

#[test]
fn valid_escaped_unicode_sequences() {
    ok("\"\\u2605\"", "\"\\u2605\"");
    ok("\"\\u2605A\"", "\"\\u2605A\"");
    ok("\"\\ud83d\\ude00\"", "\"\\ud83d\\ude00\"");
    ok(
        "\"\\u0439\\u043d\\u0444\\u043e\\u0440\\u043c\\u0430\\u0446\\u0438\\u044f\"",
        "\"\\u0439\\u043d\\u0444\\u043e\\u0440\\u043c\\u0430\\u0446\\u0438\\u044f\"",
    );
}

#[test]
fn missing_end_quote_variants() {
    ok("\"12:20", "\"12:20\"");
    ok("{\"time\":\"12:20}", "{\"time\":\"12:20\"}");
    ok(
        "{\"date\":2024-10-18T18:35:22.229Z}",
        "{\"date\":\"2024-10-18T18:35:22.229Z\"}",
    );
    ok("\"She said:", "\"She said:\"");
    ok("{\"text\": \"She said:", "{\"text\": \"She said:\"}");
    ok("[\"hello, world]", "[\"hello\", \"world\"]");
    ok("[\"hello,\"world\"]", "[\"hello\",\"world\"]");
    ok("{\"a\":\"b}", "{\"a\":\"b\"}");
    ok("{\"a\":\"b,\"c\":\"d\"}", "{\"a\":\"b\",\"c\":\"d\"}");
    ok("{\"a\":\"b,c,\"d\":\"e\"}", "{\"a\":\"b,c\",\"d\":\"e\"}");
    ok("{a:\"b,c,\"d\":\"e\"}", "{\"a\":\"b,c\",\"d\":\"e\"}");
    ok("[\"b,c,]", "[\"b\",\"c\"]");
    ok("\u{2018}abc", "\"abc\"");
    ok("\"it's working", "\"it's working\"");
}

#[test]
fn missing_end_quote_with_comments_and_concat_markers() {
    ok("[\"abc+/*comment*/\"def\"]", "[\"abcdef\"]");
    ok("[\"abc/*comment*/+\"def\"]", "[\"abcdef\"]");
    ok("[\"abc,/*comment*/\"def\"]", "[\"abc\",\"def\"]");
}

#[test]
fn stop_at_next_return_when_missing_end_quote() {
    ok("[\n\"abc,\n\"def\"\n]", "[\n\"abc\",\n\"def\"\n]");
    ok("[\n\"abc,  \n\"def\"\n]", "[\n\"abc\",  \n\"def\"\n]");
    ok("[\"abc]\n", "[\"abc\"]\n");
    ok("[\"abc  ]\n", "[\"abc\"  ]\n");
    ok("[\n[\n\"abc\n]\n]\n", "[\n[\n\"abc\"\n]\n]\n");
}

#[test]
fn string_content_and_escape_adjustments() {
    ok("\"{a:b}\"", "\"{a:b}\"");
    ok("\"foo'bar\"", "\"foo'bar\"");
    ok("\"foo\\\"bar\"", "\"foo\\\"bar\"");
    ok("'foo\"bar'", "\"foo\\\"bar\"");
    ok("'foo\\'bar'", "\"foo'bar\"");
    ok("\"foo\\'bar\"", "\"foo'bar\"");
    ok("\"\\a\"", "\"a\"");
}

#[test]
fn undefined_values_and_control_characters() {
    ok("{\"a\":undefined}", "{\"a\":null}");
    ok("[undefined]", "[null]");
    ok("\"hello\x08world\"", "\"hello\\bworld\"");
    ok("\"hello\x0cworld\"", "\"hello\\fworld\"");
    ok("\"hello\rworld\"", "\"hello\\rworld\"");
    ok("{\"key\nafter\": \"foo\"}", "{\"key\\nafter\": \"foo\"}");
    ok("[\"hello\nworld\"  ]", "[\"hello\\nworld\"  ]");
    ok("[\"hello\nworld\"\n]", "[\"hello\\nworld\"\n]");
}

#[test]
fn more_comment_behaviors() {
    ok("/* foo */ {}", " {}");
    ok("{} /* foo */ ", "{}  ");
    ok("{} /* foo ", "{} ");
    ok("\n/* foo */\n{}", "\n\n{}");
    ok(
        "{\"a\":\"foo\",/*hello*/\"b\":\"bar\"}",
        "{\"a\":\"foo\",\"b\":\"bar\"}",
    );
    ok("{\"flag\":/*boolean*/true}", "{\"flag\":true}");
    ok("{} // comment", "{} ");
    ok(
        "{\n\"a\":\"foo\",//hello\n\"b\":\"bar\"\n}",
        "{\n\"a\":\"foo\",\n\"b\":\"bar\"\n}",
    );
    ok("\"/* foo */\"", "\"/* foo */\"");
}

#[test]
fn escaped_string_content_variants() {
    ok(r#"\"hello \\"world\\"\\"#, "\"hello \\\"world\\\"\"");
    ok(r#"[\"hello \\"world\\"\"]"#, "[\"hello \\\"world\\\"\"]");
    let input = concat!(
        "{\\\"stringified\\\": \\\"hello ",
        "\\\\\"",
        "world",
        "\\\\\"",
        "\\\"}"
    );
    ok(input, "{\"stringified\": \"hello \\\"world\\\"\"}");
    ok("\\\"hello\"", "\"hello\"");
}

#[test]
fn string_concatenation_more_cases() {
    ok("\"hello\" + \" world\"", "\"hello world\"");
    ok("\"hello\" +\n \" world\"", "\"hello world\"");
    ok("\"a\"+\"b\"+\"c\"", "\"abc\"");
    ok("\"hello\" + /*comment*/ \" world\"", "\"hello world\"");
    ok(
        "{\n  \"greeting\": 'hello' +\n 'world'\n}",
        "{\n  \"greeting\": \"helloworld\"\n}",
    );
    ok("\"hello +\n \" world\"", "\"hello world\"");
    ok("\"hello +", "\"hello\"");
    ok("[\"hello +]", "[\"hello\"]");
}

#[test]
fn missing_colon_more_cases() {
    ok("{\"a\" \"b\"}", "{\"a\": \"b\"}");
    ok("{\"a\" true}", "{\"a\": true}");
    ok("{\"a\" false}", "{\"a\": false}");
    ok("{\"a\" null}", "{\"a\": null}");
    ok("{\"a\" +1}", "{\"a\":1}");
    ok("{\"a\" .5}", "{\"a\": 0.5}");
    ok("{\n\"a\" \"b\"\n}", "{\n\"a\": \"b\"\n}");
    ok("{\"a\" 'b'}", "{\"a\": \"b\"}");
    ok("{'a' 'b'}", "{\"a\": \"b\"}");
    ok("{“a” “b”}", "{\"a\": \"b\"}");
    ok("{a 'b'}", "{\"a\": \"b\"}");
    ok("{a “b”}", "{\"a\": \"b\"}");
}

// ── 29. Additional Structural Parity ──────────────────────────

#[test]
fn valid_json_more_pass_through() {
    ok(
        "{\"a\":2.3e100,\"b\":\"str\",\"c\":null,\"d\":false,\"e\":[1,2,3]}",
        "{\"a\":2.3e100,\"b\":\"str\",\"c\":null,\"d\":false,\"e\":[1,2,3]}",
    );
    ok("  { \n } \t ", "  { \n } \t ");
    ok("[1,2,[3,4,5]]", "[1,2,[3,4,5]]");
    ok("[{},[]]", "[{},[]]");
    ok(
        "\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"",
        "\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"",
    );
    ok("\"\\u260E\"", "\"\\u260E\"");
    ok("0e+2", "0e+2");
    ok("-0", "-0");
    ok("2300e+3", "2300e+3");
    ok("2300e-3", "2300e-3");
}

#[test]
fn jsonp_scalar_variants() {
    ok("callback_123(2);", "2");
    ok("callback_123(\"foo\");", "\"foo\"");
    ok("callback_123(null);", "null");
    ok("callback_123(true);", "true");
    ok("callback_123(false);", "false");
    ok("callback123({\"a\":1});", "{\"a\":1}");
    ok("jsonp_123({\"a\":1});", "{\"a\":1}");
    ok("jQuery123456789012345_678({\"ok\":true});", "{\"ok\":true}");
    ok("cb({\"a\":1});", "{\"a\":1}");
    ok("  /* foo bar */   callback_123({});  ", "     {}  ");
    ok("\n/* foo\nbar */\ncallback_123 ({});\n\n", "\n\n{}\n\n");
}

#[test]
fn unknown_function_call_is_not_wrapper() {
    ok("hello(world)", "\"hello(world)\"");
    ok("foo(1,2)", "\"foo(1,2)\"");
    ok("{expr:foo(1,2)}", "{\"expr\":\"foo(1,2)\"}");
}

#[test]
fn leading_comma_space_variants() {
    ok("[, 1,2,3]", "[ 1,2,3]");
    ok("[ , 1,2,3]", "[  1,2,3]");
    ok("{ ,\"message\": \"hi\"}", "{ \"message\": \"hi\"}");
    ok("{, \"message\": \"hi\"}", "{ \"message\": \"hi\"}");
}

#[test]
fn trailing_comma_string_non_match() {
    ok("\"[1,2,3,]\"", "\"[1,2,3,]\"");
    ok("\"{a:2,}\"", "\"{a:2,}\"");
}

#[test]
fn complex_missing_closing_brackets() {
    ok("{\"a\":{\"b\":2}", "{\"a\":{\"b\":2}}");
    ok("{\n  \"a\":{\"b\":2\n}", "{\n  \"a\":{\"b\":2\n}}");
    ok("[{\"b\":2\n]", "[{\"b\":2}\n]");
    ok("[{\"i\":1{\"i\":2}]", "[{\"i\":1},{\"i\":2}]");
    ok("[{\"i\":1,{\"i\":2}]", "[{\"i\":1},{\"i\":2}]");
    ok("{\n\"values\":[1,2,3\n}", "{\n\"values\":[1,2,3]\n}");
    ok("{\n\"values\":[1,2,3\n", "{\n\"values\":[1,2,3]}\n");
}

#[test]
fn redundant_closing_bracket_more_cases() {
    ok("{\"a\": 1 }  }  ]  }  ", "{\"a\": 1 }        ");
    ok("{\"a\":2,]}", "{\"a\":2}");
    ok("[}]", "[]");
}

#[test]
fn invalid_number_delimiter_cases() {
    ok("[0.0.1,2]", "[\"0.0.1\",2]");
    ok("[2 0.0.1 2]", "[2, \"0.0.1 2\"]");
}

#[test]
fn regex_escape_char_variant() {
    ok("/\\//", "\"/\\\\//\"");
}

#[test]
fn quote_repair_does_not_crash() {
    ok("{pattern: '’'}", "{\"pattern\": \"’\"}");
}

#[test]
fn newline_list_with_strings() {
    ok("a\nb", "[\n\"a\",\n\"b\"\n]");
}

// ── 30. Valid JSON pass-through (remaining official assertions) ──

#[test]
fn valid_object_variants() {
    ok("{}", "{}");
    ok("{\"a\": {}}", "{\"a\": {}}");
    ok("{\"a\": \"b\"}", "{\"a\": \"b\"}");
}

#[test]
fn valid_array_variants() {
    ok("[]", "[]");
    ok("[  ]", "[  ]");
    ok("[{}]", "[{}]");
    ok("{\"a\":[]}", "{\"a\":[]}");
    ok(
        "[1, \"hi\", true, false, null, {}, []]",
        "[1, \"hi\", true, false, null, {}, []]",
    );
}

#[test]
fn valid_number_variants() {
    ok("23", "23");
    ok("0", "0");
    ok("0.0", "0.0");
    ok("2.3", "2.3");
    ok("2300e3", "2300e3");
    ok("-2", "-2");
    ok("2e-3", "2e-3");
    ok("2.3e-3", "2.3e-3");
}

#[test]
fn valid_string_pass_through() {
    ok("\"str\"", "\"str\"");
}

// ── 31. Add missing quotes (remaining official) ──────────────────

#[test]
fn add_missing_quotes_complete() {
    ok("abc", "\"abc\"");
    ok("hello   world", "\"hello   world\"");
    ok(
        "{\nmessage: hello world\n}",
        "{\n\"message\": \"hello world\"\n}",
    );
    ok("{a:2}", "{\"a\":2}");
    ok("{a: 2}", "{\"a\": 2}");
    ok("{2: 2}", "{\"2\": 2}");
    ok("{true: 2}", "{\"true\": 2}");
    ok("{\n  a: 2\n}", "{\n  \"a\": 2\n}");
    ok("[a,b]", "[\"a\",\"b\"]");
    ok("[\na,\nb\n]", "[\n\"a\",\n\"b\"\n]");
}

#[test]
fn undefined_key_should_be_quoted() {
    ok("{undefined:1}", "{\"undefined\":1}");
}

// ── 32. Unquoted URL (remaining official) ────────────────────────

#[test]
fn unquoted_url_complete() {
    ok(
        "{url:https://www.bible.com/,\"id\":2}",
        "{\"url\":\"https://www.bible.com/\",\"id\":2}",
    );
    ok("[https://www.bible.com/]", "[\"https://www.bible.com/\"]");
}

// ── 33. URL missing end quote (remaining official) ───────────────

#[test]
fn url_missing_end_quote_complete() {
    ok(
        "{\"url\":\"https://www.bible.com/,\"id\":2}",
        "{\"url\":\"https://www.bible.com/\",\"id\":2}",
    );
    ok("[\"https://www.bible.com/]", "[\"https://www.bible.com/\"]");
}

// ── 34. Truncated JSON (remaining official) ──────────────────────

#[test]
fn truncated_json_complete() {
    ok("\"foo\"", "\"foo\"");
    ok("[\"foo\",", "[\"foo\"]");
    ok("{\"foo\":\"bar", "{\"foo\":\"bar\"}");
    ok("{\"foo\":", "{\"foo\":null}");
    ok("{\"foo\"", "{\"foo\":null}");
    ok("{\"foo", "{\"foo\":null}");
    ok("{", "{}");
    ok("2e+", "2e+0");
    ok("2e-", "2e-0");
}

#[test]
fn truncated_unicode_escape() {
    // These are truncated JSON (no closing quote) — the unicode escape is cut off
    ok("{\"foo\":\"bar\\u20", "{\"foo\":\"bar\"}");
    ok("\"\\u", "\"\"");
    ok("\"\\u2", "\"\"");
    ok("\"\\u260", "\"\"");
    ok("\"\\u2605", "\"\\u2605\"");
    ok("{\"s \\ud", "{\"s\": null}");
}

#[test]
fn truncated_string_with_commas() {
    ok(
        "{\"message\": \"it's working",
        "{\"message\": \"it's working\"}",
    );
    ok(
        "{\"text\":\"Hello Sergey,I hop",
        "{\"text\":\"Hello Sergey,I hop\"}",
    );
    ok(
        "{\"message\": \"with, multiple, commma's, you see?",
        "{\"message\": \"with, multiple, commma's, you see?\"}",
    );
}

// ── 35. Ellipsis complete (remaining official) ───────────────────

#[test]
fn ellipsis_with_comments() {
    ok("[1,2,3,/*comment1*/.../*comment2*/]", "[1,2,3]");
    ok(
        "[\n  1,\n  2,\n  3,\n  /*comment1*/  .../*comment2*/\n]",
        "[\n  1,\n  2,\n  3\n    \n]",
    );
    ok(
        "{\"a\":2,\"b\":3,/*comment1*/.../*comment2*/}",
        "{\"a\":2,\"b\":3}",
    );
    ok(
        "{\n  \"a\":2,\n  \"b\":3,\n  /*comment1*/.../*comment2*/\n}",
        "{\n  \"a\":2,\n  \"b\":3\n  \n}",
    );
}

#[test]
fn ellipsis_in_array_nested() {
    ok("{\"array\":[1,2,3,...]}", "{\"array\":[1,2,3]}");
}

#[test]
fn ellipsis_mid_and_start() {
    ok("[1,2,3,...,9]", "[1,2,3,9]");
    ok("[...,7,8,9]", "[7,8,9]");
    ok("[..., 7,8,9]", "[ 7,8,9]");
    ok("[...]", "[]");
    ok("[ ... ]", "[  ]");
}

#[test]
fn ellipsis_in_object_variants() {
    ok("{\"a\":2,\"b\":3, ... }", "{\"a\":2,\"b\":3  }");
    ok(
        "{\"nested\":{\"a\":2,\"b\":3, ... }}",
        "{\"nested\":{\"a\":2,\"b\":3  }}",
    );
    ok(
        "{\"a\":2,\"b\":3,...,\"z\":26}",
        "{\"a\":2,\"b\":3,\"z\":26}",
    );
    ok("{...}", "{}");
    ok("{ ... }", "{  }");
}

// ── 36. Missing start quote (remaining official) ─────────────────

#[test]
fn missing_start_quote_complete() {
    ok("[a\",b\"]", "[\"a\",\"b\"]");
    ok(
        "{a\":\"foo\",\"b\":\"bar\"}",
        "{\"a\":\"foo\",\"b\":\"bar\"}",
    );
    ok(
        "{\"a\":\"foo\",b\":\"bar\"}",
        "{\"a\":\"foo\",\"b\":\"bar\"}",
    );
}

// ── 37. Single quote variants (remaining official) ───────────────

#[test]
fn single_quote_complete() {
    ok("{'a':'foo'}", "{\"a\":\"foo\"}");
    ok("{\"a\":'foo'}", "{\"a\":\"foo\"}");
    ok("{a:'foo',b:'bar'}", "{\"a\":\"foo\",\"b\":\"bar\"}");
}

// ── 38. Special quote variants (remaining official) ──────────────

#[test]
fn special_quote_variants_complete() {
    ok("{\u{201C}a\u{201D}:\u{201C}b\u{201D}}", "{\"a\":\"b\"}");
    ok("{\u{2018}a\u{2019}:\u{2018}b\u{2019}}", "{\"a\":\"b\"}");
    ok("{\u{0060}a\u{00B4}:\u{0060}b\u{00B4}}", "{\"a\":\"b\"}");
}

#[test]
fn special_quotes_inside_normal_string() {
    ok("\"Rounded \u{2018} quote\"", "\"Rounded \u{2018} quote\"");
    ok(
        "'\u{0052}ounded \u{2018} quote'",
        "\"\u{0052}ounded \u{2018} quote\"",
    );
}

#[test]
fn mixed_quote_styles() {
    // mix single quotes: backtick open, single quote close
    ok("\u{0060}foo'", "\"foo\"");
}

// ── 39. Missing object value (remaining official) ────────────────

#[test]
fn missing_object_value_complete() {
    ok("{\"a\":,\"b\":2}", "{\"a\":null,\"b\":2}");
    ok("{\"a\":", "{\"a\":null}");
}

// ── 40. Unescaped double quote variants (remaining official) ─────

#[test]
fn unescaped_double_quotes_complete() {
    ok("[\",\",\":\"]", "[\",\",\":\"]");
    ok("[\"a\" 2", "[\"a\", 2]");
    ok("[\",\" 2", "[\",\", 2]");
}

// ── 41. Special whitespace variants (remaining official) ─────────

#[test]
fn special_whitespace_complete() {
    ok(
        "{\"a\":\u{00A0}\"foo\u{00A0}bar\"}",
        "{\"a\": \"foo\u{00A0}bar\"}",
    );
    ok("{\"a\":\u{180E}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\u{2002}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\u{202F}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\u{205F}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\u{3000}\"foo\"}", "{\"a\": \"foo\"}");
    ok("{\"a\":\u{FEFF}\"foo\"}", "{\"a\": \"foo\"}");
}

// ── 42. Comments after delimiter string (remaining official) ─────

#[test]
fn comment_after_delimiter_string_complete() {
    ok("{\"a\":\"(b)\"/* foo */}", "{\"a\":\"(b)\"}");
}

// ── 43. JSONP (remaining official) ───────────────────────────────

#[test]
fn jsonp_newline_variant() {
    ok("/* foo bar */\ncallback_123({})", "\n{}");
}

// ── 44. Markdown fenced code blocks (remaining official) ─────────

#[test]
fn markdown_fenced_complete() {
    // without closing fence
    ok("```\n{\"a\":\"b\"}\n", "\n{\"a\":\"b\"}\n");
    // without opening fence
    ok("\n{\"a\":\"b\"}\n```", "\n{\"a\":\"b\"}\n");
    // array
    ok("```\n[1,2,3]\n```", "\n[1,2,3]\n");
    // python language tag
    ok("```python\n{\"a\":\"b\"}\n```", "\n{\"a\":\"b\"}\n");
}

// ── 45. Escaped string (remaining official) ──────────────────────

// NOTE: JS official has `[\"hello\, \"world\"]` → `["hello", "world"]`
// but labels it "a bit weird". Our escaped-string parser treats `\,` as content.
// Skipped for now; revisit if needed.

#[test]
fn escaped_string_unbalanced() {
    ok("\\\"hello\"", "\"hello\"");
}

// ── 46. Trailing comma with comments (remaining official) ────────

#[test]
fn trailing_comma_with_comment_array() {
    ok("[1,2,3,/*foo*/]", "[1,2,3]");
}

#[test]
fn trailing_comma_with_comment_object() {
    ok("{\"a\":2/*foo*/,/*foo*/}", "{\"a\":2}");
}

// ── 47. Missing closing brace (remaining official) ───────────────

#[test]
fn missing_closing_brace_complete() {
    ok("{\"a\":2,", "{\"a\":2}");
}

// ── 48. Missing closing bracket array (remaining official) ───────

#[test]
fn missing_closing_bracket_array_complete() {
    ok("[1,2,3,", "[1,2,3]");
    ok("[[1,2,3,", "[[1,2,3]]");
}

// ── 49. Redundant closing bracket (remaining official) ───────────

#[test]
fn redundant_closing_bracket_complete() {
    ok("{\"a\":2]", "{\"a\":2}");
}

// ── 50. Missing comma between array items (remaining official) ───

#[test]
fn missing_comma_array_items_complete() {
    ok("{\"array\": [{}{}]}", "{\"array\": [{},{}]}");
    ok("{\"array\": [{} {}]}", "{\"array\": [{}, {}]}");
    ok("{\"array\": [{}\n{}]}", "{\"array\": [{},\n{}]}");
    ok("{\"array\": [\n{}\n{}\n]}", "{\"array\": [\n{},\n{}\n]}");
    ok("{\"array\": [\n1\n2\n]}", "{\"array\": [\n1,\n2\n]}");
    ok(
        "{\"array\": [\n\"a\"\n\"b\"\n]}",
        "{\"array\": [\n\"a\",\n\"b\"\n]}",
    );
    // normal array pass-through
    ok("[\n{},\n{}\n]", "[\n{},\n{}\n]");
}

// ── 51. Invalid number (remaining official) ──────────────────────

#[test]
fn invalid_number_es2020() {
    ok("ES2020", "\"ES2020\"");
}

// ── 52. Missing closing (unquoted string in array passthrough) ───

#[test]
fn unquoted_string_pass_through_quoted() {
    ok(
        "[\"This is C(2)\", \"This is F(3)\"]",
        "[\"This is C(2)\", \"This is F(3)\"]",
    );
}

// ── 53. Depth limit ──────────────────────────────────────────────

#[test]
fn repair_rejects_deeply_nested_input() {
    run_with_large_stack(|| {
        let depth = 513;
        let input = "[".repeat(depth);
        let result = jsonrepair(&input);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.message.contains("depth"),
            "Expected depth error, got: {}",
            err.message
        );
        assert_eq!(
            err.kind,
            openbitfun_tool_call_jsonrepair::JsonRepairErrorKind::MaxDepthExceeded
        );
    });
}

#[test]
fn repair_accepts_max_depth_nesting() {
    run_with_large_stack(|| {
        let depth = 512;
        let input = "[".repeat(depth) + &"]".repeat(depth);
        assert!(jsonrepair(&input).is_ok());
    });
}

// ── 54. Idempotency ─────────────────────────────────────────────

#[test]
fn repair_is_idempotent() {
    let inputs = vec![
        "{'name': 'John'}",
        "{a: 1, b: 2,}",
        "[1, 2, /* comment */ 3]",
        "True",
        "{foo: bar}",
        "[1 2 3]",
        "```json\n{\"a\": 1}\n```",
    ];
    for input in inputs {
        let first = jsonrepair(input).unwrap();
        let second = jsonrepair(&first).unwrap();
        assert_eq!(first, second, "Not idempotent for input: {:?}", input);
    }
}

// ── 55. Output validity ─────────────────────────────────────────

#[test]
fn repair_output_is_valid_json() {
    let inputs = vec![
        "{'name': 'John'}",
        "{a: 1, b: 2,}",
        "[1, 2, 3,]",
        "True",
        "None",
        "{foo: bar}",
        "[1 2 3]",
        "\"hello\" + \" world\"",
        "// comment\n{\"a\": 1}",
        "NaN",
        "Infinity",
        "-01",
        "00e",
        "{value:-01}",
        "{undefined:1}",
        "/\t/",
        "/\x08/",
        r"/\\z/",
    ];
    for input in inputs {
        let result = jsonrepair(input).unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&result).is_ok(),
            "Invalid JSON output for input {:?}: {:?}",
            input,
            result
        );
    }
}

// ── 56. Error enrichment ─────────────────────────────────────────

#[test]
fn error_includes_line_and_column() {
    let input = "";
    let err = jsonrepair(input).unwrap_err();
    assert!(err.line > 0, "Expected line info in error");
    assert!(err.column > 0, "Expected column info in error");
}

#[test]
fn error_includes_kind() {
    use openbitfun_tool_call_jsonrepair::JsonRepairErrorKind;
    let err = jsonrepair("").unwrap_err();
    assert_eq!(err.kind, JsonRepairErrorKind::UnexpectedEnd);
}

// ── 57. Large and hostile input regressions ─────────────────────

#[test]
fn large_deeply_nested_truncated_array_repairs_below_limit() {
    run_with_large_stack(|| {
        let depth = 128;
        let input = format!("{}true", "[".repeat(depth));
        let expected = format!("{}true{}", "[".repeat(depth), "]".repeat(depth));

        assert_eq!(jsonrepair(&input).unwrap(), expected);
    });
}

#[test]
fn large_quoted_string_passthrough_is_valid_json() {
    let payload = "x".repeat(64 * 1024);
    let input = format!("{{\"payload\":\"{payload}\"}}");

    let repaired = jsonrepair(&input).unwrap();

    assert_eq!(repaired.len(), input.len());
    assert!(repaired.starts_with("{\"payload\":\""));
    assert!(repaired.ends_with("\"}"));
    let parsed: serde_json::Value = serde_json::from_str(&repaired).unwrap();
    assert_eq!(parsed["payload"].as_str().unwrap().len(), payload.len());
}

#[test]
fn many_block_comments_are_stripped_without_panic() {
    let input = format!("[0,{}1]", "/* hostile comment */".repeat(4 * 1024));

    assert_eq!(jsonrepair(&input).unwrap(), "[0,1]");
}

#[test]
fn repeated_repairable_invalid_escapes_are_normalized() {
    let escape_count = 4 * 1024;
    let input = format!("\"{}\"", "\\a".repeat(escape_count));

    let repaired = jsonrepair(&input).unwrap();

    assert_eq!(repaired.len(), escape_count + 2);
    let parsed: String = serde_json::from_str(&repaired).unwrap();
    assert_eq!(parsed, "a".repeat(escape_count));
}

#[test]
fn repeated_invalid_unicode_escapes_return_clear_error() {
    use openbitfun_tool_call_jsonrepair::JsonRepairErrorKind;

    let input = format!("\"{}\"", "\\uZ000".repeat(512));
    let err = jsonrepair(&input).unwrap_err();

    assert_eq!(err.kind, JsonRepairErrorKind::InvalidUnicode);
    assert_eq!(err.position, 1);
    assert!(err.message.contains("\\uZ000"));
}

#[test]
fn long_truncated_array_in_object_is_closed_without_panic() {
    let item_count = 4 * 1024;
    let input = format!("{{items:[{}", "1,".repeat(item_count));
    let expected = format!("{{\"items\":[{}]}}", vec!["1"; item_count].join(","));

    assert_eq!(jsonrepair(&input).unwrap(), expected);
}
