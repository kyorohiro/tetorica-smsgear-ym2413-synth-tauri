# Tetorica SMSGEAR Synth 0.100.1

Serve this directory over HTTP and open index.html. PSG is primary, YM2413 is optional FM. No game data is bundled.

Application JavaScript, CSS, reference renderer and shared Files/Code controls are copied as readable modules, without bundling or minification. The reusable runtime, generated WASM and corresponding source/license kits are retained under js/; see js/RUNTIME.md and js/sources/. Native-effect WASM is a separate software FX implementation. Monaco may use its CDN; plain-text editing works offline.

Build commands remain in the application repository: sh scripts/package_itch_smsgear_synth.sh VERSION. Original authored source hashes are recorded in smsgear-browser-source.json.
