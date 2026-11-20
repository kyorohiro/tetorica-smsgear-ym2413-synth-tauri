# Tetorica SMSGEAR Synth — desktop verification

Date: 2026-11-20. Product `Tetorica SMSGEAR Synth`, identifier `net.tetorica.synth-smsgear-ym2413`, desktop version **0.0.1**. No commit, push, tag, hosted workflow run, signing, notarization or public release was performed.

## Included implementation

- Tauri shell based on the existing desktop wrappers, adapted to PSG / YM2413. Latest tested final-PCM transport uses nine bounded packet credits and four-packet startup, batch IPC and compensated resampling. The Rust bridge does not replace the Web chip renderer.
- One existing Menu, title Pin, native binary saves, and experimental output-device selection. Web Audio remains default. Output changes stop keyboard / Code / reference playback while keeping the editing instrument.
- Desktop-only adapters are injected when serving the original Synth module. All **937 imported Web files remain byte-identical** to the source ZIP, with readable JS/CSS, Code, timed operations, VGM preview, Files and presets retained.
- Latest-wins serialized output switching, no stale stream attachment after teardown, bounded credits and binary PCM messages. Cassette replacement waits for successful native backup saving; cancellation keeps the project.
- Original PSG / YM2413 / software-FX C/C++ sources and standalone recipes under `native-sources/`, also copied into the app resources. This supplements the original Web package without changing it. Native kits retain source/SDK/build receipts and all original licenses.
- Cross-platform Node launchers for Python import/check/test. `--version` updates package, npm lock, Cargo manifest / lock and Tauri configuration. Git attributes protect both imported and supplemental source bytes from Windows newline conversion.
- GitHub workflow is tag / manual only: macOS ARM64 / Intel, Windows x64, Linux x64 / ARM64; tags create a draft release. No hosted execution has been requested.

## Source import and provenance

Source archive: `tetorica_smsgear_synth_dev_itch.zip`, **4,064,871 bytes**. SHA-256:

`45ea198b5580b44db45a15d9070d489ac3f6406941a70d69639b75b418dd5e08`

`release.lock.json` pins that archive, all 937 original file hashes and the supplemental source manifest. Import and `--check` passed with the actual archive. Negative tests reject browser module / native source / receipt changes, unsafe ZIP paths and mismatched artifacts; transactional failures retain the previous snapshot and app version.

The three supplemental kits were independently rebuilt into temporary directories. **All five outputs matched byte-for-byte:** Sega PSG JS / WASM, YM2413 JS / WASM, and `gain.wasm` for Code effects. This used the unchanged included recipes. Compiler-version differences may produce different bytes in a user's own rebuild; no hardware accuracy claim follows from byte identity.

## Automated checks

- `npm test`: **39 Python tests and 50 Node tests passed**. Covers importer, version updates, local edits, newline preservation, binary saves, menu / Pin, native output state/races, bounded transport and sample-rate conversion.
- Isolated standalone repository copy (no parent checkout, sibling apps, build folder, original ZIP, Git metadata or dependencies): **38 Python tests passed, 1 optional original-ZIP test skipped**. Committed `dist`, `native-sources` and lock are exercised, with real browser-byte and YM2413-source tamper rejection.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`: **25 passed, 2 ignored**. The two ignored tests explicitly open real system audio devices; neither was run.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- Chromium and WebKit with real imported PSG / YM2413 / FX WASM and Worklets: passed. Verified actual Gate state and final-Master PCM for keyboard and timed Code, FX/Master controls, generated two-chip VGZ preview, output switching/races/failure recovery, native save/backup cancellation, Pin, existing menu, narrow layout and page teardown.
- Browser evidence: [desktop_browser_20261120.json](desktop_browser_20261120.json), including nine final source hashes. All physical speaker routes were held at zero gain. Native IPC was mocked; no CPAL device opened. Monaco CDN was deliberately blocked, so these Code tests use the offline textarea fallback.
- Both final app binaries contain the current desktop adapter bytes. App resource source-kit files match every entry in the supplemental manifest. Original Web files remain untouched.

## macOS builds and startup

Unsigned release app bundles built successfully for **Apple Silicon and Intel**, with `--no-sign`, `--bundles app`, `--locked` and offline Cargo. Apple signing / notarization variables were removed from these build processes. Version / identifier / architecture / binary hashes and relative app paths are recorded in [macos_builds_20261120.json](macos_builds_20261120.json).

The actual local macOS app was launched. Native accessibility inspection showed the SMSGEAR title, a single Menu, Pin, PSG / YM2413 / Mixer tabs, Files / Code controls and keyboard. Audio was not enabled in the native UI. The later final architecture builds retain the same verified original Web snapshot and embed the latest adapters.

No DMG, Developer ID signature or notarization was produced during this task. `deploy_mac.sh` remains an explicit user-run local signing route using the user's existing certificate and environment. No certificates or passwords are stored in this repository.

## Remaining checks

- Human listening, real output-device changes and longer / background native-output sessions.
- Native UI confirmation of actual save dialogs and Pin on the intended machine (browser mock and Rust validation are already covered).
- Windows / Linux builds and runtime checks after the user pushes and dispatches CI or tags a version.
- Normal online Monaco loading in each installed WebView; offline Code fallback is verified.
- User-controlled commit / push / tag, local signing / notarization and final release publication.
