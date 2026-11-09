/// A recognition result replaces the preceding partial transcript, never a user edit.
struct DictationDraftSession {
    private let base: String
    private var expectedDraft: String
    private var acceptingResults = true

    init(draft: String) {
        base = draft
        expectedDraft = draft
    }

    mutating func apply(
        transcript: String,
        currentDraft: String,
        merge: (String, String) -> String
    ) -> String? {
        guard acceptingResults, currentDraft == expectedDraft else {
            acceptingResults = false
            return nil
        }
        let updated = merge(base, transcript)
        expectedDraft = updated
        return updated
    }
}
