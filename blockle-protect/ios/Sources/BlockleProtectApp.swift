import SwiftUI

@main
struct BlockleProtectApp: App {
    @AppStorage("onboarded") private var onboarded = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ZStack(alignment: .top) {
                Brand.bg.ignoresSafeArea()
                if onboarded {
                    RootView()
                } else {
                    OnboardingView { onboarded = true }
                }
                // DEMO BUILD ONLY. Compiled out entirely of release builds, so a
                // demo cannot be confused for — or shipped as — the real app.
                if Entitlement.isDemoUnlock {
                    DemoUnlockBanner()
                }
            }
            .preferredColorScheme(.dark)
            .tint(Brand.red)
            // scenePhase .onChange does not fire for the initial .active, so a
            // cold launch would otherwise skip the check — which is exactly the
            // launch after someone disabled something and force-quit.
            .task { await DisableWatch.shared.check() }
        }
        // Registers the background-refresh handler AND runs it. Using the
        // SwiftUI modifier rather than BGTaskScheduler.register means the
        // identifier is registered before the app finishes launching, which is
        // what BGTaskScheduler requires — do not also call register().
        //
        // The request is consumed when it runs, so re-scheduling from inside
        // the handler is what keeps the chain alive.
        .backgroundTask(.appRefresh(DisableWatch.refreshTaskID)) {
            await DisableWatch.shared.check()
            DisableWatch.scheduleRefresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // Ask for the next background check on the way out, so a filter
            // turned off while the app is closed can still be noticed.
            if phase == .background { DisableWatch.scheduleRefresh() }

            // On foreground, pull the family's shared "My List" so sites a
            // relative/teammate added are blocked here too, and re-apply it.
            guard phase == .active else { return }
            Task { @MainActor in
                let hh = HouseholdModel()
                await CustomBlockStore.shared.sync(household: hh.household)
                // Check every protected filter and email the accountability
                // partner / head of household about anything switched off.
                // Driven from here, not from a view: iOS gives no notification
                // when a content blocker is toggled, so the next app launch is
                // the earliest this can possibly be noticed, and it must not
                // depend on which tab the user happens to open.
                await DisableWatch.shared.check()
            }
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }
            VaultView()
                .tabItem { Label("Vault", systemImage: "lock.doc.fill") }
            ShieldView()
                .tabItem { Label("Shield", systemImage: "checkmark.shield.fill") }
            ActivityView()
                .tabItem { Label("Activity", systemImage: "list.bullet.rectangle.fill") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .tint(Brand.red)
    }
}


/// Persistent marker shown only in the App Review demo build, where every paid
/// feature is unlocked without a purchase. Deliberately loud and deliberately
/// not dismissible: the one thing worse than a reviewer unable to see paid
/// features is a build that silently gives them away to everyone.
struct DemoUnlockBanner: View {
    var body: some View {
        Text("DEMO: PAID CONTENT UNLOCKED")
            .font(.caption2.weight(.heavy))
            .kerning(0.8)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
            .background(Color(red: 1.0, green: 0.72, blue: 0.12))
            .allowsHitTesting(false)
            .accessibilityLabel("Demo build. All paid content is unlocked.")
    }
}
