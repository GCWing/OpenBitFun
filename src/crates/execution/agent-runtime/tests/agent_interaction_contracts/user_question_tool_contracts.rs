use openbitfun_agent_runtime::user_questions::{
    ask_user_question_available_for_acp_transport, ask_user_question_available_in_context,
    build_answered_user_question_result, build_cancelled_user_question_result,
    validate_ask_user_question_input, AskUserQuestionInput, Question, QuestionOption,
};

fn question() -> Question {
    Question {
        question: "Which path should be used?".to_string(),
        header: "Path".to_string(),
        options: vec![
            QuestionOption {
                label: "A".to_string(),
                description: "Use A".to_string(),
            },
            QuestionOption {
                label: "B".to_string(),
                description: "Use B".to_string(),
            },
        ],
        multi_select: false,
    }
}

#[test]
fn ask_user_question_validation_preserves_legacy_limits() {
    assert_eq!(
        validate_ask_user_question_input(&AskUserQuestionInput { questions: vec![] })
            .expect_err("empty questions should fail"),
        "At least one question is required"
    );

    let mut too_many = vec![question(), question(), question(), question(), question()];
    assert_eq!(
        validate_ask_user_question_input(&AskUserQuestionInput {
            questions: std::mem::take(&mut too_many),
        })
        .expect_err("too many questions should fail"),
        "Maximum 4 questions allowed"
    );

    let mut missing_header = question();
    missing_header.header.clear();
    assert_eq!(
        validate_ask_user_question_input(&AskUserQuestionInput {
            questions: vec![missing_header],
        })
        .expect_err("missing header should fail"),
        "Question 1 header is required"
    );
}

#[test]
fn ask_user_question_available_flag_matches_acp_transport_contract() {
    assert!(!ask_user_question_available_for_acp_transport(Some(
        &serde_json::json!(true)
    )));
    assert!(!ask_user_question_available_for_acp_transport(Some(
        &serde_json::json!("true")
    )));
    assert!(ask_user_question_available_for_acp_transport(Some(
        &serde_json::json!(false)
    )));
    assert!(ask_user_question_available_for_acp_transport(None));
}

#[test]
fn ask_user_question_availability_honors_non_interactive_surface_fact() {
    assert!(!ask_user_question_available_in_context(
        None,
        Some(&serde_json::json!(false)),
    ));
    assert!(!ask_user_question_available_in_context(
        None,
        Some(&serde_json::json!("false")),
    ));
    assert!(ask_user_question_available_in_context(
        None,
        Some(&serde_json::json!(true)),
    ));
    assert!(!ask_user_question_available_in_context(
        Some(&serde_json::json!(true)),
        Some(&serde_json::json!(true)),
    ));
}

#[test]
fn ask_user_question_answered_and_cancelled_results_keep_wire_shape() {
    let input = AskUserQuestionInput {
        questions: vec![question()],
    };
    let answered = build_answered_user_question_result(
        &input,
        serde_json::json!({
            "0": "A"
        }),
    );

    assert_eq!(answered.data["status"], "answered");
    assert_eq!(
        answered.data["questions"][0]["question"],
        input.questions[0].question
    );
    assert_eq!(
        answered.data["questions"][0]["header"],
        input.questions[0].header
    );
    assert_eq!(answered.data["answers"]["0"], "A");
    assert!(answered
        .result_for_assistant
        .contains("- Which path should be used? (Path): \"A\""));

    let cancelled = build_cancelled_user_question_result(&input);
    assert_eq!(cancelled.data["status"], "cancelled");
    assert_eq!(cancelled.data["questions_count"], 1);
    assert_eq!(
        cancelled.result_for_assistant,
        "User input request was cancelled."
    );
}

#[test]
fn ask_user_question_input_defaults_multi_select_to_false_when_omitted() {
    let input: AskUserQuestionInput = serde_json::from_value(serde_json::json!({
        "questions": [{
            "question": "Which path should be used?",
            "header": "Path",
            "options": [
                { "label": "A", "description": "Use A" },
                { "label": "B", "description": "Use B" }
            ]
        }]
    }))
    .expect("input without multiSelect should deserialize");

    assert!(!input.questions[0].multi_select);
}
