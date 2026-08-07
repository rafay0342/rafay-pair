import XCTest

@testable import RafayPair

final class TokenVaultTests: XCTestCase {
    func testRoundTripAndClear() async throws {
        let vault = TokenVault()
        try? await vault.clear()
        let now = Date()
        let expected = TokenPair(
            accessToken: "unit-access",
            refreshToken: "unit-refresh",
            accessTokenExpiresAt: now.addingTimeInterval(900),
            refreshTokenExpiresAt: now.addingTimeInterval(2_592_000)
        )

        try await vault.save(expected)
        let restored = try await vault.load()

        XCTAssertEqual(restored?.accessToken, expected.accessToken)
        XCTAssertEqual(restored?.refreshToken, expected.refreshToken)

        try await vault.clear()
        let cleared = try await vault.load()
        XCTAssertNil(cleared)
    }
}
