@main
struct DictationDraftSessionTests {
    static func main() {
        let merge: (String, String) -> String = { $0 + $1 }
        var session = DictationDraftSession(draft: "existing ")
        precondition(session.apply(transcript: "hel", currentDraft: "existing ", merge: merge) == "existing hel")
        precondition(session.apply(transcript: "hello", currentDraft: "existing hel", merge: merge) == "existing hello")
        precondition(session.apply(transcript: "help", currentDraft: "existing hello", merge: merge) == "existing help",
                     "Recognition corrections replace the previous partial, without duplication")

        precondition(session.apply(transcript: "help me", currentDraft: "existing help and typing", merge: merge) == nil,
                     "Typing during dictation must never be overwritten")
        precondition(session.apply(transcript: "late result", currentDraft: "existing help", merge: merge) == nil,
                     "An invalidated recognition attempt cannot resume writing")

        var beforeFirstResult = DictationDraftSession(draft: "before permission prompt")
        precondition(beforeFirstResult.apply(transcript: "speech", currentDraft: "edited during permission prompt", merge: merge) == nil)
        var deleted = DictationDraftSession(draft: "delete me")
        precondition(deleted.apply(transcript: "speech", currentDraft: "", merge: merge) == nil,
                     "Deleting the draft is a user edit too")
        var restarted = DictationDraftSession(draft: "new base ")
        precondition(restarted.apply(transcript: "new speech", currentDraft: "new base ", merge: merge) == "new base new speech")
        print("Dictation draft session tests passed")
    }
}
