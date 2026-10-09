use openbitfun_tool_call_jsonrepair::jsonrepair;

fn assert_repaired_json(input: &str) {
    let repaired = jsonrepair(input).unwrap_or_else(|err| {
        panic!("repair failed for {input:?}: {err}");
    });

    serde_json::from_str::<serde_json::Value>(&repaired).unwrap_or_else(|err| {
        panic!("invalid repaired JSON for {input:?}: {repaired:?}: {err}");
    });
}

#[test]
fn plus_prefixed_bare_dot_is_rejected() {
    assert!(
        jsonrepair("+.").is_err(),
        "bare plus-prefixed dot must not repair to invalid JSON"
    );
    assert!(
        jsonrepair("[+.]").is_err(),
        "bare plus-prefixed dot in arrays must not repair to invalid JSON"
    );
}

#[test]
fn plus_prefixed_leading_dot_numbers_remain_parseable() {
    assert_repaired_json("+.5");
    assert_repaired_json("[+.5]");
    assert_repaired_json("{value:+.5}");
}

#[test]
fn plus_prefixed_exponent_only_tokens_are_rejected() {
    for input in ["+e", "+e1", "+E", "+e+1", "[+e]", "{v:+e1}"] {
        assert!(
            jsonrepair(input).is_err(),
            "plus-prefixed exponent-only token {input:?} must not repair to invalid JSON"
        );
    }
}
