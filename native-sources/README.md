# SMSGEAR native source supplements

These source kits accompany the unchanged imported Web release in ../dist/.
They provide the C/C++ implementation, original notices and standalone recipes
for the Sega PSG, YM2413 and software Code effects used by that release.
The desktop output adapter still receives final Web Audio PCM; it does not
replace the Web Synth's chip renderer.

SEGAPSG.json and YM2413.json retain the fixed SDK pin and original build
receipts. Every compiled input is checked against both the SDK source manifest
and its build receipt. The recorded outputs match both dist/generated/ and
dist/js/generated/. The pin retains its existing localCandidate metadata;
this source supplement does not declare a new SDK release.

NATIVE-FX.json records the original application C sources and recipe. Its
byteExact rebuild verification was produced by compiling those inputs and
comparing the resulting gain.wasm with dist/js/native_audio_effect.wasm.
manifest.json inventories every included supplement file except itself.

## Rebuild chip WASM

Install Emscripten, activate its environment, and choose an absolute output
directory to preserve the imported files. From this native-sources directory:

    sh segapsg-sdk/scripts/build-wasm.sh segapsg /absolute/path/to/output
    sh ym2413-sdk/scripts/build-wasm.sh ym2413 /absolute/path/to/output

The original SDK source layout and build scripts are retained unchanged.
Only the two target source subsets are included; the SDK catalog and original
RELEASE-MANIFEST.json retain the full snapshot inventory for provenance.
The build commands above need no SDK checkout, network, games or ROMs.
Each command also writes a new build-info.json into the selected output.
Compiler versions are recorded in the original receipt; a different compiler
may produce different bytes while preserving the ABI.

Sega PSG is original Tetorica BSD-3-Clause code, with hardware-documentation
credit retained in segapsg-sdk/vendor/tetorica_sega_psg/README.md. YM2413 uses
Aaron Giles's ymfm BSD-3-Clause implementation; its original license is in
ym2413-sdk/vendor/ymfm/LICENSE. Tetorica bridges and helpers retain their own
BSD notices. Keep the per-file headers and included licenses when reusing code.

## Rebuild Code effects

From this directory, with Emscripten active:

    sh code-effects/scripts/build_native_audio_effect.sh /absolute/path/to/output

The explicit output directory is required for this standalone subset. It
builds gain.wasm using the unchanged recipe and included application sources.
The implementation and its BSD-3-Clause license are in code-effects/; the
original effect guide is code-effects/docs/native_audio_effect/README.md.

To collect supplements for a future Web release from its matching source
checkout, run from the desktop repository:

    node scripts/collect-native-sources.mjs /path/to/hello_ymfm /path/to/unpacked-web-release

Collection checks the existing SDK receipts, all selected Web output hashes,
and a byte-exact rebuild of Code effects before writing any supplement files.
