import XCTest

@MainActor
final class RafayPairUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAuthenticationSurfaceIsAccessible() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.staticTexts["Care, together"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.textFields["Email"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertTrue(app.staticTexts["RafayPair never lets a partner turn on your camera or microphone."].exists)
    }
}
