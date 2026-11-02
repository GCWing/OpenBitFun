import Foundation

@main
struct MobileProcessGroupTests {
    static func tool(_ id: String, fold: Bool = true) -> MobileTimelineTool {
        MobileTimelineTool(id: id, name: "Read", phase: fold ? "COMPLETED" : "RUNNING",
            kind: "FILE", operation: "READ", target: id, filePath: "", fileLabel: "", input: "", output: "",
            question: nil, questions: [], actions: [], foldIntoSummary: fold)
    }

    static func snapshotTests() {
        func row(_ id: String = "row", text: String = "body", blocks: [MobileTimelineBlock] = [],
                 tools: [MobileTimelineTool] = [], live: Bool = false,
                 error: String? = nil, timestamp: Date? = nil) -> MobileConversationRow {
            MobileConversationRow(id: id, kind: "ASSISTANT", text: text, thinking: nil,
                images: [], tools: tools, blocks: blocks, streaming: live, typing: false,
                showRetry: error != nil, error: error, live: live, timestamp: timestamp)
        }
        let original = row()
        let same = row()
        precondition(original != same, "View equality must compare identity without scanning content")
        precondition(MobileConversationRow.reconcile([same], with: [original])[0] === original)
        for changed in [row(text: "edited"), row(live: true), row(error: "failed"),
                        row(timestamp: Date(timeIntervalSince1970: 1700000000)),
                        row(blocks: [.thinking(id: "thought", text: "Updated", streaming: true)]),
                        row(tools: [tool("new")])] {
            precondition(MobileConversationRow.reconcile([changed], with: [original])[0] === changed,
                "Every presentation change must invalidate the snapshot")
        }
        let oldTask = row(blocks: [.subagent(id: "task", title: "Task", running: true, text: "",
            children: [.thinking(id: "reason", text: "first", streaming: true)], status: "running")])
        let newTask = row(blocks: [.subagent(id: "task", title: "Task", running: true, text: "",
            children: [.thinking(id: "reason", text: "second", streaming: true)], status: "running")])
        precondition(MobileConversationRow.reconcile([newTask], with: [oldTask])[0] === newTask)
        let previous = [row("one"), row("two")]
        let incoming = [row("older"), row("one"), row("two", text: "streamed")]
        let merged = MobileConversationRow.reconcile(incoming, with: previous)
        precondition(merged.map(\.id) == ["older", "one", "two"] && merged[1] === previous[0] && merged[2] === incoming[2])
        precondition(MobileConversationRow.reconcile([], with: previous).isEmpty)
        let cocoa = NSMutableString(capacity: 10000)
        for _ in 0..<100 { cocoa.append("远程消息 café 👩🏽‍💻\n") }
        let bridged = cocoa.copy() as! NSString as String
        let snapshot = row(text: bridged)
        precondition(snapshot.text == bridged && snapshot.text.isContiguousUTF8)
        precondition(MobileConversationRow.reconcile([row(text: bridged)], with: [snapshot])[0] === snapshot)
        print("Immutable timeline snapshot tests passed")
    }

    static func main() {
        snapshotTests()
        let thought = MobileTimelineBlock.thinking(id: "reason", text: "Before", streaming: false)
        let first = MobileTimelineBlock.tools(id: "tools1", tools: [tool("one")])
        let between = MobileTimelineBlock.thinking(id: "between", text: "Between", streaming: false)
        let last = MobileTimelineBlock.tools(id: "tools2", tools: [tool("two")])
        let answer = MobileTimelineBlock.text(id: "answer", text: "Answer", streaming: true)
        let grouped = MobileProcessGroup.project([thought, first, between, last, answer])
        precondition(grouped.count == 2 && grouped[0].hasSummary && !grouped[1].hasSummary)
        precondition(grouped[0].blocks.map(\.id) == ["reason", "tool-one", "between", "tool-two"])
        precondition(grouped[1].blocks == [answer])
        precondition(!MobileProcessGroup.project([thought, first])[0].hasSummary,
            "Reasoning must remain accessible when there is no summary to expand")
        let live = MobileTimelineBlock.tools(id: "live", tools: [tool("running", fold: false)])
        let blocked = MobileProcessGroup.project([thought, first, live, between, last])
        precondition(blocked.count == 3 && blocked.allSatisfy { !$0.hasSummary },
            "Running/approval/question/plan tools must break completed activity groups")
        let child = MobileTimelineBlock.subagent(id: "task", title: "Task", running: true, text: "", children: [])
        precondition(MobileProcessGroup.project([first, child, last]).count == 3)
        let growing = MobileProcessGroup.project([thought, first, between, last,
            .tools(id: "more", tools: [tool("three")])])
        precondition(growing[0].id == grouped[0].id, "Stream growth must not reset the expansion identity")
        let adjacent = MobileProcessGroup.project([thought,
            .thinking(id: "reason2", text: "More", streaming: true), first])
        guard case let .thinking(id, text, streaming) = adjacent[0].blocks[0] else { fatalError() }
        precondition(id == "reason" && text == "Before\n\nMore" && streaming)
        let mixedTools = MobileProcessGroup.project([.tools(id: "mixed", tools: [tool("one"), tool("two"), tool("wait", fold: false), tool("three")])])
        precondition(mixedTools.count == 1 && mixedTools[0].toolsOnly && !mixedTools[0].hasSummary)
        precondition(mixedTools[0].tools.map(\.id) == ["one", "two", "wait", "three"],
            "A contiguous plain tool list shares its disclosure selection across summary and independent rows")
        for status in ["failed", "error", "timeout", "cancelled", "canceled", "rejected"] {
            precondition(MobileSubagentPresentation.failed(status))
        }
        precondition(!MobileSubagentPresentation.failed("completed"))
        let children: [MobileTimelineBlock] = [
            .thinking(id: "old", text: "Old", streaming: true),
            first, answer, .thinking(id: "tail", text: "Current", streaming: false)]
        let runningChildren = MobileSubagentPresentation.blocks(children, running: true)
        precondition(runningChildren[0] == .thinking(id: "old", text: "Old", streaming: false))
        precondition(runningChildren.last == .thinking(id: "tail", text: "Current", streaming: true))
        precondition(MobileSubagentPresentation.blocks(children, running: false).last ==
            .thinking(id: "tail", text: "Current", streaming: false))
        precondition(MobileSubagentPresentation.blocks([.tools(id: "both", tools: [tool("one"), tool("two")])], running: true).count == 2)
        precondition(MobileSubagentPresentation.preview("  short  ") == "short")
        let preview = MobileSubagentPresentation.preview(String(repeating: "x", count: 400))
        precondition(preview.count == 321 && preview.hasSuffix("…"))
        print("Mobile process grouping tests passed")
    }
}
