import SwiftUI

@main
struct BlockleProtectApp: App {
    @AppStorage("onboarded") private var onboarded = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ZStack {
                Brand.bg.ignoresSafeArea()
                if onboarded {
                    RootView()
                } else {
                    OnboardingView { onboarded = true }
                }
            }
            .preferredColorScheme(.dark)
            .tint(Brand.red)
        }
        .onChange(of: scenePhase) { _, phase in
            // On foreground, pull the family's shared "My List" so sites a
            // relative/teammate added are blocked here too, and re-apply it.
            guard phase == .active else { return }
            Task { @MainActor in
                let hh = HouseholdModel()
                await CustomBlockStore.shared.sync(household: hh.household)
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
