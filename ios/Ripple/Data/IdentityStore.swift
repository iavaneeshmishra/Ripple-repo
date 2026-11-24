import Foundation
import CryptoKit
import Security

/// Keychain failures must never be mistaken for a missing identity. Doing so could
/// silently create a different node identity and strand the user's old messages.
enum IdentityStoreError: LocalizedError {
    case keychainReadFailed(OSStatus)
    case keychainWriteFailed(OSStatus)
    case invalidStoredIdentity
    case inconsistentBackup

    var errorDescription: String? {
        switch self {
        case .keychainReadFailed(let status):
            return "Ripple couldn't read the existing identity from Keychain (status \(status)). No replacement identity was created."
        case .keychainWriteFailed(let status):
            return "Ripple couldn't securely save the identity to Keychain (status \(status))."
        case .invalidStoredIdentity:
            return "The identity stored in Keychain is invalid. Ripple did not replace it."
        case .inconsistentBackup:
            return "The private key in this backup does not match its public key. The stored identity was not changed."
        }
    }
}

/// Loads (or creates on first launch) the node identity from the Keychain.
///
/// We need the same P-256 scalar for both ECDSA and ECDH, and we need it usable
/// while the device is locked (background mesh). The raw scalar is stored as a
/// generic-password item with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
enum IdentityStore {
    private static let service = "app.ripple.mesh"
    private static let account = "identity-v1"
    private static let nameKey = "displayName"
    private static let powerProfileKey = "powerProfile"
    private static let operationQueue = DispatchQueue(label: "app.ripple.identity-store")

    /// A new identity is created only when Keychain explicitly reports that no item exists.
    static func load() throws -> Identity {
        try operationQueue.sync { try load(read: readKeychain, add: addKeychain) }
    }

    /// Shared decision path with injectable Keychain operations for deterministic tests.
    static func load(read: () throws -> Data?, add: (Data) throws -> Void) throws -> Identity {
        if let raw = try read() {
            guard let identity = try? Identity(rawScalar: raw) else {
                throw IdentityStoreError.invalidStoredIdentity
            }
            return identity
        }
        let identity = Identity.generate()
        try add(identity.signing.rawRepresentation)
        return identity
    }

    static var displayName: String? {
        get { UserDefaults.standard.string(forKey: nameKey) }
        set { UserDefaults.standard.set(newValue, forKey: nameKey) }
    }

    /// Battery profile persists across restarts (UserDefaults).
    static var powerProfile: Int? {
        get { UserDefaults.standard.object(forKey: powerProfileKey) as? Int }
        set { UserDefaults.standard.set(newValue, forKey: powerProfileKey) }
    }

    /// Backup & restore (Phase 0.3, docs/BACKUP.md): the identity is exportable by
    /// design — CryptoKit hands back the raw scalar that already lives in the Keychain.
    static func exportMaterial() throws -> (scalar: Data, wire: Data) {
        let id = try load()
        return (id.signing.rawRepresentation, id.publicKeyWire)
    }

    /// Installs a restored identity after checking it is self-consistent (the scalar's
    /// public key must equal the public key embedded in the payload). Keychain failures
    /// throw and never report success; on success the app must restart to activate.
    static func prepareRestore(scalar: Data, wire: Data) throws {
        guard scalar.count == 32, wire.count == 65,
              let id = try? Identity(rawScalar: scalar), id.publicKeyWire == wire else {
            throw IdentityStoreError.inconsistentBackup
        }
        try operationQueue.sync { try replaceKeychain(id.signing.rawRepresentation) }
        // Log at most the 4-hex suffix — full ids are never logged.
        EventLog.global.i("identity", "identity restored from backup (node \(id.nodeId.short)); restart to activate")
    }

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// Returns nil only for errSecItemNotFound. Every other status fails closed.
    private static func readKeychain() throws -> Data? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw IdentityStoreError.keychainReadFailed(status) }
        guard let data = out as? Data else { throw IdentityStoreError.invalidStoredIdentity }
        return data
    }

    private static func addKeychain(_ data: Data) throws {
        var q = query()
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw IdentityStoreError.keychainWriteFailed(status) }
    }

    /// Update atomically in place. If the item disappeared, add it; never delete the
    /// old item first, so a failed write cannot silently erase the current identity.
    private static func replaceKeychain(_ data: Data) throws {
        try replaceKeychainItem(data: data, update: { value in
            let attributes = [kSecValueData as String: value]
            return SecItemUpdate(query() as CFDictionary, attributes as CFDictionary)
        }, add: addKeychain)
    }

    /// Replacement state machine kept separate so update/add failures are testable.
    static func replaceKeychainItem(data: Data, update: (Data) -> OSStatus, add: (Data) throws -> Void) throws {
        let status = update(data)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw IdentityStoreError.keychainWriteFailed(status) }
        try add(data)
    }
}
