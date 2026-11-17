import SwiftUI

@main
struct BlockleProtectApp: App {
    @AppStorage("onboarded") private var onboarded = false
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
