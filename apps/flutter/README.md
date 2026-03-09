## OpenClaw Flutter App

Status: **planned**. This project has not started development yet.

A cross-platform Flutter client for OpenClaw, targeting Android, iOS, macOS, Windows, and Linux from a single codebase.

### Goals

- Provide a unified OpenClaw mobile/desktop experience across all major platforms.
- Connect to OpenClaw gateway via WebSocket for real-time chat, voice, and device control.
- Share UI components and business logic across platforms while preserving native look and feel.

### Planned Features

- [ ] Gateway connection (Setup Code / Manual / QR scan)
- [ ] Chat UI with streaming support
- [ ] Voice tab
- [ ] Screen tab (canvas / A2UI)
- [ ] Push notifications
- [ ] Biometric lock and secure token storage
- [ ] Settings and device management
- [ ] Platform-specific permission handling (camera, mic, location, notifications)

### Target Platforms

| Platform | Min Version |
|----------|-------------|
| Android  | API 24 (Android 7.0) |
| iOS      | 16.0 |
| macOS    | 13.0 |
| Windows  | 10 |
| Linux    | Ubuntu 22.04+ (or equivalent) |

### Prerequisites

- Flutter SDK 3.x+
- Dart SDK (bundled with Flutter)
- Platform-specific toolchains (Android SDK, Xcode, Visual Studio, etc.)

### Getting Started

> Not yet available. The following commands are placeholders for the future project structure.

```bash
cd apps/flutter
flutter pub get
flutter run
```

### Project Structure (Planned)

```
apps/flutter/
├── lib/
│   ├── main.dart
│   ├── app/              # App-level config, routing, themes
│   ├── features/         # Feature modules (chat, connect, voice, screen, settings)
│   ├── core/             # Shared services (gateway client, auth, storage)
│   └── widgets/          # Reusable UI components
├── android/
├── ios/
├── macos/
├── windows/
├── linux/
├── test/
└── pubspec.yaml
```

### Contributions

This Flutter app is in the planning stage.
For ideas, questions, or contributions, please open an issue or reach out on Discord.
