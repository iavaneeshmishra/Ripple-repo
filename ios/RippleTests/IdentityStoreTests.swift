import XCTest
import Security
@testable import Ripple

final class IdentityStoreTests: XCTestCase {
    func testOnlyMissingKeychainItemCreatesAnIdentity() throws {
        var added: Data?
        let identity = try IdentityStore.load(read: { nil }, add: { added = $0 })
        XCTAssertEqual(added, identity.signing.rawRepresentation)
    }

    func testKeychainReadFailureDoesNotGenerateOrWriteReplacementIdentity() {
        var didAdd = false
        XCTAssertThrowsError(try IdentityStore.load(
            read: { throw IdentityStoreError.keychainReadFailed(errSecInteractionNotAllowed) },
            add: { _ in didAdd = true }
        )) { error in
            guard let storeError = error as? IdentityStoreError,
                  case .keychainReadFailed(let status) = storeError else {
                XCTFail("expected a Keychain read failure")
                return
            }
            XCTAssertEqual(status, errSecInteractionNotAllowed)
        }
        XCTAssertFalse(didAdd)
    }

    func testInvalidStoredScalarFailsClosedWithoutReplacingIt() {
        var didAdd = false
        XCTAssertThrowsError(try IdentityStore.load(
            read: { Data([0x01]) },
            add: { _ in didAdd = true }
        )) { error in
            guard let storeError = error as? IdentityStoreError,
                  case .invalidStoredIdentity = storeError else {
                XCTFail("expected an invalid stored identity error")
                return
            }
        }
        XCTAssertFalse(didAdd)
    }

    func testKeychainAddFailurePreventsReturningAnUnstoredIdentity() {
        XCTAssertThrowsError(try IdentityStore.load(
            read: { nil },
            add: { _ in throw IdentityStoreError.keychainWriteFailed(errSecNotAvailable) }
        )) { error in
            guard let storeError = error as? IdentityStoreError,
                  case .keychainWriteFailed(let status) = storeError else {
                XCTFail("expected a Keychain write failure")
                return
            }
            XCTAssertEqual(status, errSecNotAvailable)
        }
    }

    func testInconsistentBackupIsRejectedBeforeKeychainWrite() {
        XCTAssertThrowsError(try IdentityStore.prepareRestore(scalar: Data([0x01]), wire: Data())) { error in
            guard let storeError = error as? IdentityStoreError,
                  case .inconsistentBackup = storeError else {
                XCTFail("expected an inconsistent backup error")
                return
            }
        }
    }

    func testReplaceUsesUpdateAndFallsBackToCheckedAddOnlyWhenMissing() throws {
        let value = Data([1, 2, 3])
        var didAdd = false
        try IdentityStore.replaceKeychainItem(data: value, update: { supplied in
            XCTAssertEqual(supplied, value)
            return errSecSuccess
        }, add: { _ in didAdd = true })
        XCTAssertFalse(didAdd)

        try IdentityStore.replaceKeychainItem(data: value, update: { _ in errSecItemNotFound }, add: { supplied in
            XCTAssertEqual(supplied, value)
            didAdd = true
        })
        XCTAssertTrue(didAdd)
    }

    func testReplaceFailureIsPropagatedAndDoesNotFallBackToAdd() {
        var didAdd = false
        XCTAssertThrowsError(try IdentityStore.replaceKeychainItem(
            data: Data([1]),
            update: { _ in errSecInteractionNotAllowed },
            add: { _ in didAdd = true }
        )) { error in
            guard let storeError = error as? IdentityStoreError,
                  case .keychainWriteFailed(let status) = storeError else {
                XCTFail("expected a Keychain write failure")
                return
            }
            XCTAssertEqual(status, errSecInteractionNotAllowed)
        }
        XCTAssertFalse(didAdd)
    }

    func testFallbackAddFailureIsPropagated() {
        XCTAssertThrowsError(try IdentityStore.replaceKeychainItem(
            data: Data([1]),
            update: { _ in errSecItemNotFound },
            add: { _ in throw IdentityStoreError.keychainWriteFailed(errSecNotAvailable) }
        )) { error in
            guard let storeError = error as? IdentityStoreError,
                  case .keychainWriteFailed(let status) = storeError else {
                XCTFail("expected a Keychain write failure")
                return
            }
            XCTAssertEqual(status, errSecNotAvailable)
        }
    }
}
