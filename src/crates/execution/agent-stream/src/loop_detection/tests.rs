//! Synthetic loop corpus for the detector core.
//!
//! Every kind gets at least two positive cases and every entry of the plan's
//! false-positive exclusion list gets a negative case. Corpora are deterministic
//! and self-describing: no clocks, no randomness, no fixtures on disk.

use super::{LoopDetectorConfig, LoopKind, LoopVerdict, OutputLoopDetector, ThinkingLoopDetector};

/// Chunk size used by most tests: a realistic streamed-delta size.
const CHUNK_CHARS: usize = 512;

fn feed_text(
    detector: &mut OutputLoopDetector,
    text: &str,
    chunk_chars: usize,
) -> Vec<LoopVerdict> {
    let mut verdicts = Vec::new();
    let mut buffer = String::new();
    let mut buffered = 0usize;
    for c in text.chars() {
        buffer.push(c);
        buffered += 1;
        if buffered >= chunk_chars {
            if let Some(verdict) = detector.feed(&buffer) {
                verdicts.push(verdict);
            }
            buffer.clear();
            buffered = 0;
        }
    }
    if !buffer.is_empty() {
        if let Some(verdict) = detector.feed(&buffer) {
            verdicts.push(verdict);
        }
    }
    if let Some(verdict) = detector.analyze() {
        verdicts.push(verdict);
    }
    verdicts
}

fn detect(text: &str) -> Vec<LoopVerdict> {
    feed_text(&mut OutputLoopDetector::new(), text, CHUNK_CHARS)
}

fn kinds(verdicts: &[LoopVerdict]) -> Vec<LoopKind> {
    verdicts.iter().map(|verdict| verdict.kind).collect()
}

fn is_hard_loop(kind: LoopKind) -> bool {
    matches!(
        kind,
        LoopKind::VerbatimBlock
            | LoopKind::NearRepetition
            | LoopKind::PhraseStuck
            | LoopKind::PeriodicSequence
    )
}

fn assert_only(text: &str, expected: LoopKind) {
    let verdicts = detect(text);
    assert!(
        !verdicts.is_empty(),
        "expected {expected} but the detector reported nothing"
    );
    assert_eq!(kinds(&verdicts), vec![expected; verdicts.len()]);
}

fn assert_no_hard_loop(text: &str) {
    let verdicts = detect(text);
    for verdict in &verdicts {
        assert!(
            !is_hard_loop(verdict.kind),
            "unexpected loop verdict for a legitimate text: {verdict:?}"
        );
    }
}

// ---------------------------- corpus builders ----------------------------

/// Repeated phrase separated by distinct narration: irregular verbatim blocks.
fn verbatim_irregular_corpus() -> String {
    const PHRASE: &str = "the same conclusion returns here and the evidence stays unchanged";
    const FILLERS: [&str; 5] = [
        "First the reviewer inspects the staged pipeline and records what changed in the trace.",
        "Second the reviewer compares the recorded output against the earlier baseline snapshot.",
        "Third the reviewer notes that the stage finished without producing new observations.",
        "Fourth the reviewer repeats the check and finds exactly the same situation once more.",
        "Fifth the reviewer closes the loop and files the same unchanged conclusion again.",
    ];
    let mut out = String::new();
    out.push_str("The review proceeds as follows. ");
    for filler in FILLERS {
        out.push_str(PHRASE);
        out.push_str(". ");
        out.push_str(filler);
        out.push(' ');
    }
    out
}

/// Inline chanting: the same short clause repeated without a break.
fn chanting_corpus() -> String {
    "let me think about it ".repeat(60)
}

/// Near repetition with controlled variation: a long unit repeated a few times,
/// each repetition differing only in a few five-character slots. No 50-character
/// block is byte-identical across repetitions, and the repetition interval is
/// larger than the verbatim distance rule.
fn near_repetition_corpus(repetitions: usize) -> String {
    const SEGMENTS: [&str; 5] = [
        "the reviewer returns to the same staged conclusion because the earlier note stays in the working trace ",
        "the pipeline stage repeats its own observation without recording any progress and the summary keeps saying ",
        "the next step waits for evidence that never appears so the same sentence is rebuilt from the same fragments ",
        "no new token carries information here because every clause restates the clause that came before it in order ",
        "the trace remains level while the conclusion is rewritten with identical wording and the same closing line ",
    ];
    const SLOTS: [&str; 16] = [
        "alpha", "bravo", "charm", "dalet", "eagle", "fable", "giant", "hazel", "ivory", "jolly",
        "karma", "lunar", "mango", "noble", "ocean", "prism",
    ];
    let mut out = String::new();
    for repetition in 0..repetitions {
        for (index, segment) in SEGMENTS.iter().enumerate() {
            out.push_str(segment);
            out.push_str(SLOTS[(repetition * SEGMENTS.len() + index) % SLOTS.len()]);
            out.push(' ');
        }
    }
    out
}

/// Deterministic filler words, used to build a long non-repeating block.
fn pseudo_words(count: usize, seed: u64) -> String {
    const WORDS: [&str; 16] = [
        "stage", "trace", "plan", "note", "result", "evidence", "step", "signal", "window",
        "reviewer", "pipeline", "record", "summary", "delta", "stream", "check",
    ];
    let mut state = seed;
    let mut out = String::new();
    for index in 0..count {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let word = WORDS[(state >> 33) as usize % WORDS.len()];
        if index > 0 {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// The plan's long-period case: a ~936-token block repeated four times.
fn long_period_block_corpus() -> String {
    let block = pseudo_words(936, 0x5eed_1234);
    let mut out = String::new();
    for index in 0..4 {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&block);
    }
    out
}

/// Connector stalling: the same connector token repeated without progress.
fn phrase_stuck_corpus() -> String {
    "wait ".repeat(120)
}

/// Connector stalling with an alternating short connector n-gram.
fn phrase_stuck_alternating_corpus() -> String {
    "so but alternatively ".repeat(40)
}

/// Source text for the periodic corpora. Fillers are 45-character slices, so one
/// period unit is exactly 50 characters and the period is `k * 50` characters.
const PERIODIC_TEXT: &str = "the trace stays level while the stage waits and the reviewer notes that nothing \
changes in the working set so the plan rests unchanged and the same evidence returns to the same conclusion \
again and again without any new observation appearing anywhere in the trace at all so the reviewer keeps the \
note and moves on carefully with the same sentence rebuilt once more in the same order and shape while the \
delta stays flat and the summary is rewritten from the same fragments in the same arrangement for the third \
time now and the check completes without new evidence anywhere";

const PERIODIC_SLOTS: [&str; 16] = [
    "alpha", "bravo", "charm", "dalet", "eagle", "fable", "giant", "hazel", "ivory", "jolly",
    "karma", "lunar", "mango", "noble", "ocean", "prism",
];

/// Period of exactly `period_blocks * 50` characters, never byte-identical.
fn periodic_corpus(period_blocks: usize, repeats: usize) -> String {
    assert!(PERIODIC_TEXT.is_ascii());
    let filler_span = PERIODIC_TEXT.len() - 45;
    let mut out = String::new();
    for repetition in 0..repeats {
        for phase in 0..period_blocks {
            let start = (phase * 73) % filler_span;
            out.push_str(&PERIODIC_TEXT[start..start + 45]);
            out.push_str(
                PERIODIC_SLOTS[(repetition * period_blocks + phase) % PERIODIC_SLOTS.len()],
            );
        }
    }
    out
}

/// Numeric counter series with a long identical tail per line.
fn numeric_drift_corpus() -> String {
    let mut out = String::new();
    for index in 2074..2100 {
        out.push_str(&format!(
            "building variant {index} of the matrix and recording the result\n"
        ));
    }
    out
}

/// Letter counter series (`8.1a -> 8.1z`) from the plan's example.
fn alpha_drift_corpus() -> String {
    let mut out = String::new();
    for letter in 'a'..='z' {
        out.push_str(&format!(
            "stage 8.1{letter} result recorded for the matrix\n"
        ));
    }
    out
}

/// Markdown table with identical rows (exclusion: tables).
fn repeated_table_corpus() -> String {
    let mut out = String::from(
        "the reviewer summarizes the table below\n\n| stage | status | note |\n|---|---|---|\n",
    );
    for _ in 0..12 {
        out.push_str("| alpha | beta | gamma |\n");
    }
    out.push_str("\nand then the summary ends\n");
    out
}

/// Numeric table with incrementing values (exclusion: tables).
fn numeric_table_corpus() -> String {
    let mut out =
        String::from("the reviewer summarizes the counters below\n\n| item | state |\n|---|---|\n");
    for index in 1..=20 {
        out.push_str(&format!("| {index} | recorded |\n"));
    }
    out.push_str("\nthe table ends here\n");
    out
}

/// Fenced code block with repeated identical lines (exclusion: fenced code).
fn repeated_code_corpus() -> String {
    let mut out = String::from("the reviewer inspects the helper below\n\n```rust\n");
    for _ in 0..12 {
        out.push_str("let value = compute(input);\n");
    }
    out.push_str("```\n\nthe helper returns early\n");
    out
}

/// Batch-like repeated labels inside a list (exclusion: lists).
fn repeated_list_corpus() -> String {
    let mut out = String::from("the batch results follow\n\n");
    for index in 1..=12 {
        out.push_str(&format!("- processed file batch-{index:02}\n"));
    }
    out.push_str("\nthe batch is complete\n");
    out
}

/// Repeating headings, quotes and thematic breaks (exclusion: those structures).
fn repeated_structure_lines_corpus() -> String {
    let mut out = String::new();
    for _ in 0..8 {
        out.push_str("# Section heading\n\n> the same quoted sentence returns here\n\n---\n\n");
    }
    out.push_str("the report closes\n");
    out
}

/// Legitimate polling-like status lines, too far apart to be a loop.
fn polling_corpus() -> String {
    let mut out = String::from("The job is running.\n\n");
    for round in 0..3 {
        out.push_str("waiting for the build to finish\n\n");
        out.push_str(&pseudo_words(120, 91 + round as u64));
        out.push_str("\n\n");
    }
    out.push_str("the build finished successfully and the report was written\n");
    out
}

/// Ordinary prose with a legitimately repeated sentence.
fn prose_corpus() -> String {
    let mut out = String::new();
    out.push_str(
        "The detector core keeps every expensive pass out of the streaming delta path. \
         A caller feeds text and decides when an analysis is forced, so the cost stays \
         proportional to the amount of new content rather than to the number of deltas. ",
    );
    out.push_str(&pseudo_words(90, 11));
    out.push_str(
        ". The detector core keeps every expensive pass out of the streaming delta path. ",
    );
    out.push_str(&pseudo_words(90, 12));
    out.push_str(". Repetition inside code blocks, tables, lists, headings and quotes is excluded by construction, ");
    out.push_str("so a report full of structured output does not look like a loop. ");
    out.push_str(&pseudo_words(90, 13));
    out.push_str(".\n");
    out
}

// ---------------------------- positives ----------------------------

#[test]
fn detects_verbatim_block_at_irregular_intervals() {
    assert_only(&verbatim_irregular_corpus(), LoopKind::VerbatimBlock);
}

#[test]
fn detects_verbatim_block_for_inline_chanting() {
    let verdicts = detect(&chanting_corpus());
    assert_eq!(kinds(&verdicts), vec![LoopKind::VerbatimBlock]);
    let verdict = &verdicts[0];
    assert_eq!(verdict.confidence, 0.95);
    assert!(!verdict.requires_arbitration());
    assert!(verdict.evidence.occurrences >= 4);
    assert!(verdict
        .evidence
        .mean_interval_chars
        .is_some_and(|interval| interval <= 400.0));
}

#[test]
fn detects_near_repetition_with_variation() {
    let verdicts = detect(&near_repetition_corpus(8));
    assert_eq!(kinds(&verdicts), vec![LoopKind::NearRepetition]);
    let verdict = &verdicts[0];
    assert!(
        verdict
            .evidence
            .max_similarity
            .is_some_and(|similarity| similarity >= 0.85),
        "similarity: {:?}",
        verdict.evidence.max_similarity
    );
    assert!(verdict.evidence.matched_scale_chars.is_some());
}

#[test]
fn detects_long_period_repeated_block() {
    let verdicts = detect(&long_period_block_corpus());
    assert_eq!(kinds(&verdicts), vec![LoopKind::NearRepetition]);
    let verdict = &verdicts[0];
    assert!(
        verdict
            .evidence
            .max_similarity
            .is_some_and(|similarity| similarity >= 0.9),
        "similarity: {:?}",
        verdict.evidence.max_similarity
    );
    assert!(!verdict.requires_arbitration());
}

#[test]
fn detects_stuck_connector_phrase() {
    assert_only(&phrase_stuck_corpus(), LoopKind::PhraseStuck);
}

#[test]
fn detects_stuck_connector_ngram() {
    let verdicts = detect(&phrase_stuck_alternating_corpus());
    assert_eq!(kinds(&verdicts), vec![LoopKind::PhraseStuck]);
    assert!(verdicts[0].evidence.consecutive_repeats >= 8);
}

#[test]
fn detects_periodic_sequence_for_every_supported_period() {
    for period_blocks in 1..=5 {
        let verdicts = detect(&periodic_corpus(period_blocks, 10));
        assert_eq!(
            kinds(&verdicts),
            vec![LoopKind::PeriodicSequence],
            "period {period_blocks} units"
        );
        assert_eq!(
            verdicts[0].evidence.period_units,
            Some(period_blocks),
            "reported period for {period_blocks} units"
        );
        assert!(verdicts[0].evidence.occurrences >= 4);
    }
}

#[test]
fn classifies_numeric_series_as_predictable_drift() {
    let verdicts = detect(&numeric_drift_corpus());
    assert!(
        !verdicts.is_empty(),
        "the counter series was not classified"
    );
    for verdict in &verdicts {
        assert_eq!(verdict.kind, LoopKind::PredictableDrift, "{verdict:?}");
    }
    let verdict = &verdicts[0];
    assert_eq!(verdict.confidence, 0.25);
    assert!(!verdict.requires_arbitration());
    assert!(verdict.evidence.occurrences >= 4);
}

#[test]
fn classifies_letter_series_as_predictable_drift() {
    let verdicts = detect(&alpha_drift_corpus());
    assert!(!verdicts.is_empty(), "the letter series was not classified");
    for verdict in &verdicts {
        assert_eq!(verdict.kind, LoopKind::PredictableDrift, "{verdict:?}");
    }
}

#[test]
fn structure_exclusion_is_what_suppresses_code_repetition() {
    let corpus = repeated_code_corpus();
    assert_no_hard_loop(&corpus);

    let config = LoopDetectorConfig {
        structure_exclusion_enabled: false,
        ..Default::default()
    };
    let verdicts = feed_text(
        &mut OutputLoopDetector::with_config(config),
        &corpus,
        CHUNK_CHARS,
    );
    assert!(
        verdicts
            .iter()
            .any(|verdict| verdict.kind == LoopKind::VerbatimBlock),
        "without exclusion the repeated code lines must register: {:?}",
        kinds(&verdicts)
    );
}

// ---------------------------- negatives ----------------------------

#[test]
fn ignores_repeated_table_rows() {
    assert_no_hard_loop(&repeated_table_corpus());
}

#[test]
fn ignores_numeric_tables() {
    assert_no_hard_loop(&numeric_table_corpus());
}

#[test]
fn ignores_repeated_code_lines_in_fenced_blocks() {
    assert_no_hard_loop(&repeated_code_corpus());
}

#[test]
fn ignores_repeated_list_labels() {
    assert_no_hard_loop(&repeated_list_corpus());
}

#[test]
fn ignores_repeated_headings_quotes_and_breaks() {
    assert_no_hard_loop(&repeated_structure_lines_corpus());
}

#[test]
fn ignores_batch_labels_with_a_constant_counter() {
    let mut out = String::new();
    for index in 1..=30 {
        out.push_str(&format!("processed item {index} of 30 with status ok\n"));
    }
    assert_no_hard_loop(&out);
}

#[test]
fn ignores_legitimate_polling_status_lines() {
    assert_no_hard_loop(&polling_corpus());
}

#[test]
fn ignores_ordinary_prose_with_a_repeated_sentence() {
    assert_no_hard_loop(&prose_corpus());
}

#[test]
fn ignores_short_and_empty_input() {
    let mut detector = OutputLoopDetector::new();
    assert!(detector.feed("").is_none());
    assert!(detector.feed("short line of text").is_none());
    assert!(detector.analyze().is_none());
    assert_eq!(detector.state().window_chars(), "short line of text".len());
}

// ---------------------------- invariants ----------------------------

#[test]
fn repeated_input_produces_identical_verdicts() {
    let corpora = [
        verbatim_irregular_corpus(),
        chanting_corpus(),
        near_repetition_corpus(4),
        long_period_block_corpus(),
        phrase_stuck_corpus(),
        periodic_corpus(3, 10),
        numeric_drift_corpus(),
        prose_corpus(),
        repeated_code_corpus(),
    ];
    for corpus in corpora {
        for chunk_chars in [97usize, 613, 4096] {
            let first = feed_text(&mut OutputLoopDetector::new(), &corpus, chunk_chars);
            let second = feed_text(&mut OutputLoopDetector::new(), &corpus, chunk_chars);
            assert_eq!(
                first, second,
                "chunk size {chunk_chars} is not deterministic"
            );
        }
    }
}

#[test]
fn chunk_boundaries_do_not_change_the_verdict() {
    let corpus = chanting_corpus();
    for chunk_chars in [7usize, 100, 1024, 100_000] {
        let verdicts = feed_text(&mut OutputLoopDetector::new(), &corpus, chunk_chars);
        assert_eq!(
            kinds(&verdicts),
            vec![LoopKind::VerbatimBlock],
            "chunk size {chunk_chars}"
        );
    }
}

#[test]
fn the_same_loop_is_not_reported_twice() {
    let corpus = chanting_corpus();
    let mut detector = OutputLoopDetector::new();
    let verdicts = feed_text(&mut detector, &corpus, CHUNK_CHARS);
    assert_eq!(verdicts.len(), 1);
    assert!(detector.analyze().is_none());
    assert!(detector.analyze().is_none());
}

#[test]
fn reset_clears_reported_loop_memory() {
    let corpus = chanting_corpus();
    let mut detector = OutputLoopDetector::new();
    assert!(!feed_text(&mut detector, &corpus, CHUNK_CHARS).is_empty());
    detector.reset();
    assert!(!feed_text(&mut detector, &corpus, CHUNK_CHARS).is_empty());
}

#[test]
fn detects_loops_after_the_window_prunes_older_text() {
    let mut corpus = String::new();
    for paragraph in 0..8u64 {
        corpus.push_str(&pseudo_words(600, 1000 + paragraph));
        corpus.push_str("\n\n");
    }
    corpus.push_str(&"the same warning repeats here ".repeat(40));
    let mut detector = OutputLoopDetector::new();
    let verdicts = feed_text(&mut detector, &corpus, CHUNK_CHARS);
    assert!(
        verdicts
            .iter()
            .any(|verdict| verdict.kind == LoopKind::VerbatimBlock),
        "expected a verbatim verdict after pruning: {:?}",
        kinds(&verdicts)
    );
    // The window stays bounded, so memory does not grow with the session.
    assert!(detector.state().window_chars() <= LoopDetectorConfig::default().window_chars);
    assert!(detector.state().total_chars() > 16_384);
}

#[test]
fn analysis_passes_are_throttled_by_the_stride() {
    let corpus = pseudo_words(6000, 7);
    let mut detector = OutputLoopDetector::new();
    for chunk in corpus.as_bytes().chunks(64) {
        let text = std::str::from_utf8(chunk).expect("ascii chunks");
        detector.feed(text);
    }
    let stride = LoopDetectorConfig::default().analysis_stride_chars as u64;
    let expected = detector.state().total_chars() / stride + 2;
    assert!(
        detector.state().analysis_passes() <= expected,
        "analysis passes {} exceeded the stride bound {}",
        detector.state().analysis_passes(),
        expected
    );
}

#[test]
fn state_can_be_snapshotted_and_resumed() {
    let corpus = chanting_corpus();
    let mut detector = OutputLoopDetector::new();
    detector.feed(&corpus[..200]);
    let snapshot = detector.state().clone();
    let mut resumed = OutputLoopDetector::from_state(LoopDetectorConfig::default(), snapshot);
    let verdicts = feed_text(&mut resumed, &corpus[200..], CHUNK_CHARS);
    assert!(
        verdicts
            .iter()
            .any(|verdict| verdict.kind == LoopKind::VerbatimBlock),
        "resumed detector lost the loop: {:?}",
        kinds(&verdicts)
    );
}

#[test]
fn generous_config_still_produces_a_verdict() {
    // A very small block on a short window must not panic or divide by zero.
    let config = LoopDetectorConfig {
        window_chars: 300,
        block_chars: 0,
        near_repetition_scales_chars: Vec::new(),
        analysis_stride_chars: 0,
        period_unit_chars: 0,
        evidence_sample_chars: 0,
        ..Default::default()
    };
    let verdicts = feed_text(
        &mut OutputLoopDetector::with_config(config),
        &chanting_corpus(),
        64,
    );
    assert!(!verdicts.is_empty());
}

#[test]
fn compression_redundancy_is_available_on_demand() {
    let mut detector = OutputLoopDetector::new();
    detector.feed(&chanting_corpus());
    let repetitive = detector
        .compression_redundancy()
        .expect("a long repetitive window is measurable");
    detector.reset();
    detector.feed(&prose_corpus());
    let prose = detector
        .compression_redundancy()
        .expect("a long prose window is measurable");
    assert!(
        repetitive > prose,
        "repetitive {repetitive} should exceed prose {prose}"
    );
}

#[test]
fn loop_kind_strings_match_the_serialized_form() {
    for kind in [
        LoopKind::VerbatimBlock,
        LoopKind::NearRepetition,
        LoopKind::PhraseStuck,
        LoopKind::PeriodicSequence,
        LoopKind::PredictableDrift,
        LoopKind::ThinkingStagnation,
        LoopKind::ReasoningRunaway,
    ] {
        let serialized = serde_json::to_string(&kind).expect("kind serializes");
        assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
    }
    assert!(LoopKind::VerbatimBlock.is_output_loop());
    assert!(!LoopKind::ThinkingStagnation.is_output_loop());
}

// ---------------------------- thinking detector ----------------------------

/// A thinking block with a small edit, used for adjacent-similarity tests.
fn thinking_block(seed: u64, edits: usize) -> String {
    let mut text = pseudo_words(160, seed);
    if edits > 0 {
        text.push_str(" and the reviewer keeps repeating the same staged conclusion");
    }
    text
}

#[test]
fn flags_adjacent_thinking_stagnation() {
    let mut detector = ThinkingLoopDetector::new();
    assert!(detector.feed_block(&thinking_block(21, 0)).is_none());
    assert!(detector.feed_block(&thinking_block(21, 1)).is_none());
    let verdict = detector
        .feed_block(&thinking_block(21, 2))
        .expect("two consecutive stagnations must report");
    assert_eq!(verdict.kind, LoopKind::ThinkingStagnation);
    assert_eq!(verdict.confidence, 0.75);
    assert!(verdict.requires_arbitration());
    assert_eq!(verdict.evidence.consecutive_repeats, 2);
    assert!(verdict.evidence.samples.len() >= 2);
}

#[test]
fn flags_repeated_identical_thinking_blocks() {
    let block = thinking_block(77, 0);
    let mut detector = ThinkingLoopDetector::new();
    detector.feed_block(&block);
    detector.feed_block(&block);
    let verdict = detector.feed_block(&block).expect("identical blocks");
    assert_eq!(verdict.kind, LoopKind::ThinkingStagnation);
    assert!(verdict
        .evidence
        .max_similarity
        .is_some_and(|similarity| similarity >= 0.99));
}

#[test]
fn ignores_distinct_thinking_blocks() {
    let mut detector = ThinkingLoopDetector::new();
    for seed in 1..6u64 {
        assert!(detector.feed_block(&thinking_block(seed * 31, 0)).is_none());
    }
    assert_eq!(detector.state().stagnation_streak(), 0);
}

#[test]
fn single_similar_thinking_pair_is_not_reported() {
    let mut detector = ThinkingLoopDetector::new();
    assert!(detector.feed_block(&thinking_block(9, 0)).is_none());
    assert!(detector.feed_block(&thinking_block(9, 1)).is_none());
    assert_eq!(detector.state().stagnation_streak(), 1);
}

#[test]
fn ignores_short_thinking_blocks() {
    let mut detector = ThinkingLoopDetector::new();
    for _ in 0..5 {
        assert!(detector.feed_block("short thought").is_none());
    }
    assert_eq!(detector.state().stagnation_streak(), 0);
}

#[test]
fn flags_stuck_phrase_inside_thinking() {
    let mut detector = ThinkingLoopDetector::new();
    let block = format!(
        "{} wait wait wait wait wait wait wait wait wait wait wait",
        pseudo_words(40, 5)
    );
    let verdict = detector.feed_block(&block).expect("connector stalling");
    assert_eq!(verdict.kind, LoopKind::PhraseStuck);
    assert!(verdict.evidence.consecutive_repeats >= 8);
}

#[test]
fn flags_reasoning_runaway_from_usage_bypass() {
    let mut detector = ThinkingLoopDetector::new();
    assert!(detector.feed_usage(900, 0).is_none());
    let verdict = detector
        .feed_usage(1200, 0)
        .expect("sustained reasoning growth with no completion output");
    assert_eq!(verdict.kind, LoopKind::ReasoningRunaway);
    assert_eq!(verdict.confidence, 0.35);
    assert!(!verdict.requires_arbitration());
    assert_eq!(verdict.evidence.consecutive_repeats, 2);
    assert_eq!(verdict.evidence.reasoning_tokens_delta, Some(1200));
}

#[test]
fn tracks_a_reasoning_runaway_episode_without_repeating_it() {
    // A long opaque reasoning phase with no completion output at all: the streak
    // keeps growing, but the caller is told once, not once per sample.
    let mut detector = ThinkingLoopDetector::new();
    let verdicts: Vec<_> = (0..4).map(|_| detector.feed_usage(2048, 0)).collect();
    assert_eq!(
        verdicts.iter().filter(|verdict| verdict.is_some()).count(),
        1
    );
    assert_eq!(
        verdicts[1].as_ref().map(|verdict| verdict.kind),
        Some(LoopKind::ReasoningRunaway)
    );
    assert_eq!(detector.state().reasoning_runaway_streak(), 4);
    assert_eq!(
        verdicts[1]
            .as_ref()
            .and_then(|verdict| verdict.evidence.reasoning_tokens_delta),
        Some(2048)
    );
}

#[test]
fn reasoning_runaway_is_reported_once_per_episode() {
    let mut detector = ThinkingLoopDetector::new();
    detector.feed_usage(900, 0);
    assert!(detector.feed_usage(900, 0).is_some());
    assert!(detector.feed_usage(900, 0).is_none());
    // A sample that fails the predicate ends the episode, so a later sustained
    // growth reports again instead of being suppressed forever.
    assert!(detector.feed_usage(900, 400).is_none());
    detector.feed_usage(900, 0);
    assert!(detector.feed_usage(900, 0).is_some());
}

#[test]
fn does_not_flag_usage_with_completion_output() {
    let mut detector = ThinkingLoopDetector::new();
    for _ in 0..4 {
        assert!(detector.feed_usage(900, 250).is_none());
    }
    for _ in 0..4 {
        assert!(detector.feed_usage(100, 0).is_none());
    }
    assert_eq!(detector.state().reasoning_runaway_streak(), 0);
}

#[test]
fn thinking_detector_is_deterministic_and_resettable() {
    let blocks = [
        thinking_block(21, 0),
        thinking_block(21, 1),
        thinking_block(21, 2),
        "wait wait wait wait wait wait wait wait wait wait".to_string(),
    ];
    let run = || {
        let mut detector = ThinkingLoopDetector::new();
        blocks
            .iter()
            .map(|block| detector.feed_block(block))
            .collect::<Vec<_>>()
    };
    let first = run();
    let second = run();
    assert_eq!(first, second);

    let mut detector = ThinkingLoopDetector::new();
    for block in &blocks {
        detector.feed_block(block);
    }
    detector.reset();
    assert_eq!(detector.state().stagnation_streak(), 0);
    assert!(detector.feed_block(&blocks[0]).is_none());
}
