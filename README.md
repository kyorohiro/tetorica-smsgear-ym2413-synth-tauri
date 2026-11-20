# Tetorica SMSGEAR Synth — Desktop

A Tauri desktop version of **Tetorica SMSGEAR Synth**, for Sega Master System / Game Gear sound: three PSG tones, Noise, Game Gear stereo, and optional YM2413 two-operator FM / Rhythm. Play the keyboard, inspect a VGM reference, edit sounds, or perform with JavaScript.

The imported Web modules stay readable and retain their original bytes. There is no minification, obfuscation or separate desktop chip implementation. The desktop extension adds one shared Menu, Pin, native save dialogs and output-device controls. No game music or ROM content is included.

## Run and build

Node.js 22+, Python 3 and the Rust / Tauri prerequisites are required. Dependencies are pinned in `package-lock.json` and `src-tauri/Cargo.lock`.

```sh
npm ci
npm run dev
```

The Web release is committed under `dist/`, so a normal clone needs no parent Tetorica checkout or fresh ZIP. Both dev and build verify its hashes first.

```sh
npm test
npm run test:browser
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run build -- --no-sign --bundles app -- --locked  # unsigned macOS app
```

Windows: `npm run build -- --bundles nsis -- --locked`.
Linux: `npm run build -- --bundles deb,appimage -- --locked`.
Build each platform on its own runner. A Mac does not produce Windows / Linux installers using the ordinary Tauri build.

## Import a newer Web release

Generate the SMSGEAR ZIP in the parent project with `sh scripts/package_itch_smsgear_synth.sh`, then run here:

```sh
npm run import:release -- ../../release/tetorica_smsgear_synth_dev_itch.zip --version 0.0.2
```

`--version` changes the desktop `package.json`, npm lock, Cargo manifest / lock and `tauri.conf.json`; it does not select a ZIP by versioned filename. Omit it to keep the current app version. The Node launcher selects `python` on Windows and `python3` elsewhere.

```sh
npm run import:release -- --check
```

Import validates the readable browser module receipt, source / license kits and exact PSG / YM2413 / software-FX artifacts. If a newer Web ZIP changes its native artifacts, first regenerate the matching supplemental kits using the command in [native-sources/README.md](native-sources/README.md). `release.lock.json` records original archive identity and every imported file. Git attributes preserve pinned Web and supplemental source bytes on Windows.

## Desktop sound and controls

Web Audio is the default output. Open **Menu → Audio output** to select experimental **Native (Rust)** output and a device. It transfers the same stereo PCM from the final Master bus to CPAL; keyboard, Code, software FX and VGM reference playback stay on their original renderer. Changing output stops playback and held notes while preserving the instrument. It does not add a second Synth or a native timed-operation engine.

Use the existing Menu for New Cassette, import/export, audio settings and Reload. Pin sits beside the title. File and Cassette exports use native save dialogs; cancellation keeps the workspace. Code, timed reservations, Files working/saved state and preset editing use the Web Synth implementation.

Native output is an optional PCM transport. Real output-device changes, listening, background operation and extended sessions still need checks on the intended machine. Automated browser checks always mute physical output and mock the native device service.

## Modify the app

- `dist/synth-smsgear/`: readable application UI, instrument, VGM importer/player and Code host.
- `dist/js/`: reusable JavaScript runtime, Worklets, type/source navigation, WASM and source/license kits.
- `desktop/`: desktop-only menu/save/pin and final-bus audio adapters, injected at serving time.
- `src-tauri/src/`: local resource hosting, native save / pin commands and Rust PCM output.
- `native-sources/`: matching PSG, YM2413 and software-effect core sources, pinned artifact identities and standalone rebuild recipes. These supplemental sources are also shipped as Tauri bundle resources.

Original Web files are not patched by the desktop importer. You may edit them directly for your own fork, then explicitly record accepted local changes:

```sh
npm run record:edits
npm run import:release -- --check
```

This retains original-release identities and records local changes separately. A future import intentionally replaces the Web snapshot; save local changes in Git first. Core changes require rebuilding their WASM and updating matching source/artifact receipts, rather than merely accepting a mismatched binary.

## Release builds

GitHub Actions runs only for `v*` tags or **Run workflow**. It checks the committed assets and builds macOS ARM64 / Intel, Windows x64 and Linux x64 / ARM64 bundles. Tags attach assets to a **draft** GitHub release; review it before publishing. Hosted macOS bundles are unsigned.

For local signed / notarized macOS releases, use your existing local Developer ID certificate and set `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_PASSWORD` in your environment, then run `sh deploy_mac.sh`. The script builds both Intel and Apple Silicon app / DMG bundles. Do not commit passwords or certificates; this repository does not require uploading a Mac certificate to GitHub.

## Sources and licenses

The desktop wrapper is BSD-3-Clause; individual source components retain their own notices and licenses. The Web source and native component notices are included in `dist/`, with supplemental matching rebuild sources under `native-sources/`.

- [Web Synth / parent source](https://github.com/kyorohiro/hello_ymfm_wasm)
- [Original C/C++ sound-chip SDK](https://github.com/kyorohiro/tetorica-soundchip-native)
- [Tauri](https://tauri.app/)

See [TODO](docs/todo_20261120.md) and local verification notes under `docs/` for completed automated checks and remaining human/platform verification.
