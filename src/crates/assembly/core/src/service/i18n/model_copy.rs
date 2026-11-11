//! Model-facing localized copy.
//!
//! These strings are not rendered directly in the UI, but they shape model
//! output and should stay aligned with the app language registry.

use super::types::LocaleId;

pub struct CodeReviewCopy {
    pub description: &'static str,
    pub overall_assessment: &'static str,
    pub confidence_note: &'static str,
    pub issue_title: &'static str,
    pub issue_description: &'static str,
    pub issue_suggestion: &'static str,
    pub positive_points: &'static str,
}

const CODE_REVIEW_ZH_CN: CodeReviewCopy = CodeReviewCopy {
    description: "提交代码审核结果。完成审核分析后必须调用本工具提交结构化审核报告。所有用户可见的文本字段必须使用简体中文。",
    overall_assessment: "总体评价（2-3 句，使用简体中文）",
    confidence_note: "上下文局限说明（可选，使用简体中文）",
    issue_title: "问题标题（简体中文）",
    issue_description: "问题描述（简体中文）",
    issue_suggestion: "修复建议（可选，简体中文）",
    positive_points: "代码优点（1-2 条，简体中文）",
};

const CODE_REVIEW_ZH_TW: CodeReviewCopy = CodeReviewCopy {
    description: "提交程式碼審核結果。完成審核分析後必須呼叫本工具提交結構化審核報告。所有使用者可見的文字欄位必須使用繁體中文。",
    overall_assessment: "整體評價（2-3 句，使用繁體中文）",
    confidence_note: "上下文限制說明（可選，使用繁體中文）",
    issue_title: "問題標題（繁體中文）",
    issue_description: "問題描述（繁體中文）",
    issue_suggestion: "修復建議（可選，繁體中文）",
    positive_points: "程式碼優點（1-2 條，繁體中文）",
};

const CODE_REVIEW_EN_US: CodeReviewCopy = CodeReviewCopy {
    description: "Submit code review results. After completing the review analysis, you must call this tool to submit a structured review report. All user-visible text fields must be in English (per app language setting).",
    overall_assessment: "Overall assessment (2-3 sentences, in English)",
    confidence_note: "Context limitation note (optional, in English)",
    issue_title: "Issue title (in English)",
    issue_description: "Issue description (in English)",
    issue_suggestion: "Fix suggestion (in English, optional)",
    positive_points: "Code strengths (1-2 items, in English)",
};

pub fn code_review_copy_for_language(lang_code: &str) -> &'static CodeReviewCopy {
    match LocaleId::from_str(lang_code).unwrap_or_default() {
        LocaleId::ZhCN => &CODE_REVIEW_ZH_CN,
        LocaleId::ZhTW => &CODE_REVIEW_ZH_TW,
        LocaleId::EnUS | LocaleId::FrFr => &CODE_REVIEW_EN_US,
    }
}
