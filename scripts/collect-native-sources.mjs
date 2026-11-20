// SPDX-License-Identifier: BSD-3-Clause
// Re-create the supplemental source kits from the matching application checkout.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const record = bytes => ({bytes: bytes.length, sha256: sha256(bytes)});

export async function collectNativeSources({sourceRoot, webRoot, destination = join(repository, 'native-sources')}) {
  sourceRoot = resolve(sourceRoot);
  webRoot = resolve(webRoot);
  const {checkRuntimeArtifacts} = await import(pathToFileURL(join(sourceRoot, 'scripts/runtime_artifacts.mjs')));
  await checkRuntimeArtifacts({root: sourceRoot, ids: ['segapsg', 'ym2413', 'native_audio_effect'], mirrors: true});
  const sdk = join(sourceRoot, 'third_party/tetorica-soundchip-native');
  const pinBytes = await readFile(join(sourceRoot, 'third_party/soundchip-sdk.json'));
  const pin = JSON.parse(pinBytes);
  const manifestBytes = await readFile(join(sdk, 'RELEASE-MANIFEST.json'));
  assert.equal(sha256(manifestBytes), pin.manifestSha256, 'Fixed SDK manifest mismatch');
  const manifest = JSON.parse(manifestBytes);
  const buildInfo = JSON.parse(await readFile(join(sourceRoot, 'tetorica_src/runtime/generated/build-info.json')));
  const payload = new Map();

  for (const component of ['segapsg', 'ym2413']) {
    const build = buildInfo.artifacts.find(item => item.id === component);
    assert(build, `Missing ${component} build receipt`);
    assert.equal(sha256(JSON.stringify(build.sourceFiles)), build.sourceFingerprint, `${component} source fingerprint mismatch`);
    const notices = component === 'segapsg'
      ? ['vendor/tetorica_sega_psg/LICENSE', 'vendor/tetorica_sega_psg/README.md', 'docs/chip-differences.md']
      : ['vendor/ymfm/LICENSE', 'vendor/tetorica_sega_psg/LICENSE', 'vendor/tetorica_sega_psg/README.md', 'docs/chip-differences.md'];
    const names = [...new Set([...build.sourceFiles.map(item => item.path), 'LICENSE', 'sdk.json',
      'catalog/source_inventory.json', ...notices])].sort();
    const inputs = [];
    for (const name of names) {
      const bytes = await readFile(join(sdk, name));
      const expected = manifest.files[name];
      assert(expected && bytes.length === expected.size && sha256(bytes) === expected.sha256, `${component} SDK input mismatch: ${name}`);
      const compiled = build.sourceFiles.find(item => item.path === name);
      if (compiled) assert(compiled.size === bytes.length && compiled.sha256 === sha256(bytes), `${component} compiled input mismatch: ${name}`);
      const path = `${component}-sdk/${name}`;
      payload.set(path, bytes);
      inputs.push({path, ...record(bytes)});
    }
    payload.set(`${component}-sdk/RELEASE-MANIFEST.json`, manifestBytes);
    payload.set(`${component}-sdk/soundchip-sdk.json`, pinBytes);
    const generated = {};
    for (const name of [`${component}_wasm.js`, `${component}_wasm.wasm`]) {
      const bytes = await readFile(join(sourceRoot, 'tetorica_src/runtime/generated', name));
      const output = build.outputs.find(item => item.path === name);
      assert(output && output.size === bytes.length && output.sha256 === sha256(bytes), `${component} output receipt mismatch: ${name}`);
      for (const relative of [`generated/${name}`, `js/generated/${name}`]) {
        assert(bytes.equals(await readFile(join(webRoot, relative))), `Web release differs from native source receipt: ${relative}`);
      }
      generated[name] = record(bytes);
    }
    payload.set(`${component.toUpperCase()}.json`, json({schemaVersion: 1, component, sdk: pin, build, inputs, generated}));
  }

  const fxNames = (await readdir(join(sourceRoot, 'tetorica_src/native/audio_effect')))
    .filter(name => /\.(?:c|h)$/.test(name)).map(name => `tetorica_src/native/audio_effect/${name}`);
  fxNames.push('scripts/build_native_audio_effect.sh', 'LICENSE', 'docs/native_audio_effect/README.md');
  const fxInputs = [];
  for (const sourcePath of fxNames.sort()) {
    const bytes = await readFile(join(sourceRoot, sourcePath));
    const path = `code-effects/${sourcePath}`;
    payload.set(path, bytes);
    fxInputs.push({path, sourcePath, ...record(bytes)});
  }
  const effect = await readFile(join(sourceRoot, 'tetorica_src/runtime/generated/effects/gain.wasm'));
  assert(effect.equals(await readFile(join(webRoot, 'js/native_audio_effect.wasm'))), 'Web NativeFX output differs');
  const temporary = await mkdtemp(join(tmpdir(), 'smsgear-native-fx-'));
  let compilerVersion;
  try {
    execFileSync('sh', [join(sourceRoot, 'scripts/build_native_audio_effect.sh'), temporary], {cwd: sourceRoot, stdio: 'inherit'});
    assert(effect.equals(await readFile(join(temporary, 'gain.wasm'))), 'NativeFX rebuild is not byte-exact; matching source provenance cannot be recorded');
    compilerVersion = execFileSync('emcc', ['--version'], {encoding: 'utf8'}).trim();
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
  payload.set('NATIVE-FX.json', json({schemaVersion: 1, component: 'native_audio_effect', inputs: fxInputs,
    generated: {'native_audio_effect.wasm': record(effect)},
    rebuildVerification: {byteExact: true, compiler: {command: 'emcc', version: compilerVersion},
      sourceFingerprint: sha256(JSON.stringify(fxInputs)), output: record(effect)}}));

  payload.set('README.md', Buffer.from(`# SMSGEAR native source supplements

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
`));

  // All input and output checks above complete before the destination changes.
  const files = [...payload].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({path, ...record(bytes)}));
  payload.set('manifest.json', json({schemaVersion: 1, component: 'smsgear-native-sources', files}));
  for (const [name, bytes] of payload) {
    const target = join(destination, name);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, bytes);
  }
  return {files: payload.size, sdkVersion: pin.version, nativeFx: record(effect)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/collect-native-sources.mjs <matching-source-checkout> <unpacked-web-release>');
  console.log(JSON.stringify(await collectNativeSources({sourceRoot: process.argv[2], webRoot: process.argv[3]}), null, 2));
}
