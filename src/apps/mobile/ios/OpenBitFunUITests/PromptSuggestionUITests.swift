import XCTest

final class PromptSuggestionUITests: XCTestCase {
    func testSuggestionFillsTheDraftWithoutSending() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--prompt-suggestion-preview", "--english"]
        app.launch()
        let suggestion = app.buttons["composer-prompt-suggestion"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 15))
        XCTAssertTrue(suggestion.isHittable)
        let before = XCTAttachment(screenshot: app.screenshot())
        before.name = "Prompt suggestion before acceptance"
        before.lifetime = .keepAlways
        add(before)
        suggestion.tap()
        let editor = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "  Run the tests and summarize any failures.  ")
        XCTAssertFalse(suggestion.exists)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let after = XCTAttachment(screenshot: app.screenshot())
        after.name = "Prompt suggestion copied into draft"
        after.lifetime = .keepAlways
        add(after)
    }
}
