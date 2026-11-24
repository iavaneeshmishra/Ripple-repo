import SwiftUI
import SwiftData
import UserNotifications

/// Minimal Objective-C exception handoff for the next Diagnostics export.
/// It never reads messages or identity material; values are bounded and long
/// hex/base64-like tokens are redacted before touching UserDefaults.
enum CrashLog {
    private static let pendingKey = "ripple.pendingException"

    static func install() {
        NSSetUncaughtExceptionHandler(rippleUncaughtException)
    }

    static func takePending() -> String? {
        let defaults = UserDefaults.standard
        let value = defaults.string(forKey: pendingKey)
        defaults.removeObject(forKey: pendingKey)
        return value
    }

    fileprivate static func record(_ exception: NSException) {
        let name = String(exception.name.rawValue.prefix(128))
        let rawReason = exception.reason ?? "reason unavailable"
        let oneLine = rawReason.replacingOccurrences(of: "[\\r\\n\\t]+", with: " ", options: .regularExpression)
        let withoutHex = oneLine.replacingOccurrences(of: "(?i)\\b[0-9a-f]{16,}\\b", with: "<redacted>", options: .regularExpression)
        let sanitized = withoutHex.replacingOccurrences(of: "\\b[A-Za-z0-9+/_-]{32,}={0,2}\\b", with: "<redacted>", options: .regularExpression)
        UserDefaults.standard.set("name=\(name); reason=\(sanitized.prefix(512))", forKey: pendingKey)
        UserDefaults.standard.synchronize()
    }
}

private func rippleUncaughtException(_ exception: NSException) {
    CrashLog.record(exception)
}

@MainActor
private final class AppStartup: ObservableObject {
    let mesh: MeshService?
    let identityFailure: String?

    init(container: ModelContainer) {
        do {
            mesh = try MeshService(container: container)
            identityFailure = nil
        } catch {
            mesh = nil
            identityFailure = error.localizedDescription
        }
    }
}

private struct IdentityUnavailableView: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "key.fill")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text("Ripple couldn't securely load your identity")
                .font(.title2.bold())
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text("Mesh networking is stopped to avoid replacing your identity. Unlock the device and reopen Ripple to retry; if the problem continues, contact support.")
                .font(.footnote)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
}

@MainActor
@main
struct RippleApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    private let container: ModelContainer
    @StateObject private var startup: AppStartup

    init() {
        let c = Persistence.container()
        self.container = c
        self._startup = StateObject(wrappedValue: AppStartup(container: c))
    }

    var body: some Scene {
        WindowGroup {
            if let mesh = startup.mesh {
                HomeView().environmentObject(mesh)
            } else {
                IdentityUnavailableView(message: startup.identityFailure ?? "Keychain returned an unknown error.")
            }
        }
        .modelContainer(container)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Notification taps can arrive before HomeView installs its navigation handler.
    static var pendingConversation: String?
    static var openConversation: ((String) -> Void)? {
        didSet {
            guard let handler = openConversation, let pending = pendingConversation else { return }
            pendingConversation = nil
            handler(pending)
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        CrashLog.install()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let conversation = response.notification.request.content.userInfo["conversation"] as? String {
            await MainActor.run {
                if let handler = Self.openConversation {
                    handler(conversation)
                } else {
                    Self.pendingConversation = conversation
                }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
