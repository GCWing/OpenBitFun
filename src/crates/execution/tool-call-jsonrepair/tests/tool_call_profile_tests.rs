use openbitfun_tool_call_jsonrepair::repair_tool_call_json;

#[test]
fn markdown_comment_markers_are_preserved_as_tool_argument_content() {
    for (input, marker) in [
        (r##"{"content": # Markdown heading"}"##, "#"),
        (r##"{"content": //}"##, "//"),
        (r##"{"content": /* Markdown block */}"##, "/*"),
    ] {
        let repaired = repair_tool_call_json(input)
            .unwrap_or_else(|error| panic!("repair failed for {input:?}: {error}"));

        assert!(
            repaired.contains(marker),
            "comment-like marker was discarded for {input:?}: {repaired:?}"
        );
        serde_json::from_str::<serde_json::Value>(&repaired)
            .unwrap_or_else(|error| panic!("repaired output was invalid JSON: {error}"));
    }
}
