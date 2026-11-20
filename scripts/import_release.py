"""Import the unmodified SMSGEAR Web release and pin every extracted byte."""
# SPDX-License-Identifier: BSD-3-Clause
import argparse
import importlib.util
import hashlib
from html.parser import HTMLParser
import json
import posixpath
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BROWSER_RECEIPT = 'smsgear-browser-source.json'
BROWSER_ENTRIES = {
    'synth-smsgear/synth.js', 'synth-smsgear/song_worklet.js',
    'synth-smsgear/psg_worklet.js', 'synth-smsgear/opll_worklet.js',
    'synth-smsgear/synth.css', 'js/native-fx-worklet.js',
}
HTML_ENTRIES = {'index.html', 'synth-smsgear/index.html'}
REQUIRED = {
    *HTML_ENTRIES, *BROWSER_ENTRIES, BROWSER_RECEIPT,
    'tetorica_smsgear_synth.webp', 'LICENSE', 'PACKAGE.md',
    'synth-smsgear/README.md', 'synth-smsgear/fixtures.js',
    'js/RUNTIME.md', 'js/runtime-manifest.json',
    'generated/segapsg_wasm.js', 'generated/segapsg_wasm.wasm',
    'generated/ym2413_wasm.js', 'generated/ym2413_wasm.wasm',
    'js/generated/segapsg_wasm.js', 'js/generated/segapsg_wasm.wasm',
    'js/generated/ym2413_wasm.js', 'js/generated/ym2413_wasm.wasm',
    'js/native_audio_effect.wasm',
}
BUILD_HELPERS = {'scripts/build-wasm.sh', 'scripts/record_wasm_build.mjs'}
NATIVE_BUILD_INPUTS = {
    'segapsg': BUILD_HELPERS | {
        'scripts/build_segapsg_wasm.sh', 'wasm/segapsg_wasm.cpp',
        'vendor/ymfm/chip_state.h',
        'vendor/tetorica_sega_psg/segapsg.cpp',
        'vendor/tetorica_sega_psg/segapsg.h',
    },
    'ym2413': BUILD_HELPERS | {
        'scripts/build_ym2413_wasm.sh', 'wasm/ym2413_wasm.cpp',
        'wasm/opn_state.h', 'wasm/ymfm_wasm_interface.h',
        'vendor/ymfm/chip_state.h', 'vendor/ymfm/ymfm.h',
        'vendor/ymfm/ymfm_fm.h', 'vendor/ymfm/ymfm_fm.ipp',
        'vendor/ymfm/ymfm_opl.cpp', 'vendor/ymfm/ymfm_opl.h',
        'vendor/tetorica_sega_psg/segapsg.cpp',
        'vendor/tetorica_sega_psg/segapsg.h',
    },
}
FX_SOURCES = {'scripts/build_native_audio_effect.sh', 'LICENSE', 'docs/native_audio_effect/README.md'} | {
    'tetorica_src/native/audio_effect/' + name for name in [
        'compressor.c', 'compressor.h', 'eq.c', 'extra_fx.c', 'extra_fx.h',
        'gain.c', 'graph.c', 'noise.c', 'noise_gate.c', 'noise_gate.h',
        'reverb.c', 'reverb.h', 'sample.c',
    ]
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Expected a regular JSON receipt: {path}')
    return json.loads(path.read_bytes().decode('utf-8'), object_pairs_hook=unique_object)


def records(value, label):
    if not isinstance(value, list) or not value:
        raise ValueError(f'Expected {label} source records')
    result = {}
    for record in value:
        if not isinstance(record, dict):
            raise ValueError(f'Expected a {label} source record')
        name = safe_name(record.get('path'))
        if name.casefold() in {key.casefold() for key in result}:
            raise ValueError(f'Duplicate {label} source record: {name}')
        result[name] = record
    return result


def verify_record(destination, hashes, record, name, size_key='bytes'):
    safe_name(name)
    if not isinstance(record, dict):
        raise ValueError(f'Expected a source receipt record: {name}')
    if name not in hashes:
        raise ValueError(f'Missing recorded release file: {name}')
    if (type(record.get(size_key)) is not int or record[size_key] < 0
            or not valid_hash(record.get('sha256'))
            or record[size_key] != (destination / name).stat().st_size
            or record['sha256'] != hashes[name]):
        raise ValueError(f'Release source receipt mismatch: {name}')


def resolve_dependency(name, dependency):
    if (not isinstance(dependency, str) or not dependency.startswith(('./', '../'))
            or '\\' in dependency or any(ord(char) < 32 for char in dependency)):
        raise ValueError(f'Expected a relative local module import: {name}')
    pathname = re.split(r'[?#]', dependency, maxsplit=1)[0]
    return safe_name(posixpath.normpath(posixpath.join(posixpath.dirname(name), pathname)))


class EntryHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts, self.styles, self.assets = [], [], []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'script':
            if attrs.get('type') != 'module' or not attrs.get('src'):
                raise ValueError('Expected an external module script in SMSGEAR HTML')
            self.scripts.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.styles.append(attrs.get('href'))
        for attribute in ['src', 'href']:
            target = attrs.get(attribute)
            if target and target.startswith(('./', '../')):
                self.assets.append(target)



def authored_imports(text):
    tokens = []
    pattern = re.compile(
        r"(?P<comment>/\*[\s\S]*?\*/|//[^\r\n]*)"
        r"|(?P<template>`(?:\\[\s\S]|[^`\\])*`)"
        r"|(?P<string>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')"
        r"|(?P<word>[A-Za-z_$][A-Za-z0-9_$]*)|(?P<symbol>[^\s])")
    for match in pattern.finditer(text):
        if match.lastgroup not in {'comment', 'template'}:
            tokens.append((match.lastgroup, match.group()))
    result = set()
    for index, token in enumerate(tokens):
        if token not in [('word', 'import'), ('word', 'export')]:
            continue
        following = tokens[index + 1:]
        if not following:
            continue
        value = None
        if token[1] == 'import' and following[0][0] == 'string':
            value = following[0][1][1:-1]
        elif token[1] == 'import' and len(following) > 1 and following[0][1] == '(' and following[1][0] == 'string':
            value = following[1][1][1:-1]
        elif following[0][1] not in {'.', '('} and (token[1] == 'import' or following[0][1] in {'{', '*'}):
            for offset, item in enumerate(following[:-1]):
                if item[1] == ';':
                    break
                if item == ('word', 'from') and following[offset + 1][0] == 'string':
                    value = following[offset + 1][1][1:-1]
                    break
        if value and value.startswith(('./', '../')):
            result.add(value)
    return result

def validate_browser(destination, hashes):
    browser = read_json(destination / BROWSER_RECEIPT)
    if not isinstance(browser, dict) or browser.get('minified') is not False:
        raise ValueError('Expected readable, unminified SMSGEAR browser source receipts')
    modules = records(browser.get('modules'), 'readable browser module')
    entries = records(browser.get('entries'), 'browser entry')
    if not BROWSER_ENTRIES <= entries.keys() or not entries.keys() <= modules.keys():
        raise ValueError('Expected complete SMSGEAR browser entry receipts')
    inputs = browser.get('inputs')
    if (not isinstance(inputs, list) or any(not isinstance(name, str) for name in inputs)
            or len(inputs) != len(set(inputs))
            or set(inputs) != {record.get('sourcePath') for record in modules.values()}):
        raise ValueError('Browser input inventory differs from readable modules')
    for name, record in modules.items():
        verify_record(destination, hashes, record, name)
        if record.get('sourcePath') != 'docs/' + name:
            raise ValueError(f'Browser module differs from its readable source identity: {name}')
        imports = record.get('localImports')
        if (not isinstance(imports, list) or any(not isinstance(item, str) for item in imports)
                or len(imports) != len(set(imports))):
            raise ValueError(f'Expected unique local module imports: {name}')
        for dependency in imports:
            target = resolve_dependency(name, dependency)
            if target not in modules:
                if target not in {'generated/segapsg_wasm.js', 'generated/ym2413_wasm.js'}:
                    raise ValueError(f'Missing recorded browser module dependency: {name} -> {target}')
        # Check literal authored imports as well as the recorded graph. Tokens
        # keep comments, strings and template examples from becoming fake edges.
        text = (destination / name).read_bytes().decode('utf-8')
        literal_imports = authored_imports(text)
        if not literal_imports <= set(imports):
            raise ValueError(f'Browser receipt omits an authored module import: {name}')
    for name, record in entries.items():
        verify_record(destination, hashes, record, name)
        if record != modules[name]:
            raise ValueError(f'Browser entry differs from its readable module receipt: {name}')
    for name in HTML_ENTRIES:
        text = (destination / name).read_bytes().decode('utf-8')
        if 'Tetorica SMSGEAR Synth' not in text or 'YM2413' not in text:
            raise ValueError(f'Expected SMSGEAR HTML identity: {name}')
        document = EntryHTML()
        document.feed(text)
        if ([resolve_dependency(name, item) for item in document.scripts] != ['synth-smsgear/synth.js']
                or [resolve_dependency(name, item) for item in document.styles] != ['synth-smsgear/synth.css']):
            raise ValueError(f'Expected SMSGEAR module and stylesheet entry links: {name}')
        for target in document.assets:
            if resolve_dependency(name, target) not in hashes:
                raise ValueError(f'Missing local HTML asset: {name} -> {target}')


def validate_native(source_root, source_hashes, destination, hashes, component):
    prefix = f'{component}-sdk/'
    receipt = read_json(source_root / f'{component.upper()}.json')
    if (not isinstance(receipt, dict) or type(receipt.get('schemaVersion')) is not int
            or receipt['schemaVersion'] != 1 or receipt.get('component') != component):
        raise ValueError(f'Expected {component} native source identity')
    inputs = records(receipt.get('inputs'), component + ' native input')
    required = {prefix + name for name in NATIVE_BUILD_INPUTS[component] | {'LICENSE', 'sdk.json'}}
    if not required <= inputs.keys():
        raise ValueError(f'Expected complete {component} core, wrapper and build inputs')
    for name, record in inputs.items():
        if not name.startswith(prefix):
            raise ValueError(f'Unexpected {component} source kit path: {name}')
        verify_record(source_root, source_hashes, record, name)
    sdk = receipt.get('sdk')
    manifest_name = prefix + 'RELEASE-MANIFEST.json'
    manifest = read_json(source_root / manifest_name)
    if (not isinstance(sdk, dict) or sdk != read_json(source_root / (prefix + 'soundchip-sdk.json'))
            or sdk.get('name') != 'tetorica-soundchip-native'
            or sdk.get('manifestSha256') != source_hashes.get(manifest_name)
            or not isinstance(manifest, dict) or not isinstance(manifest.get('files'), dict)
            or sdk.get('version') != manifest.get('version')):
        raise ValueError(f'{component} SDK manifest / release identity mismatch')
    metadata = read_json(source_root / (prefix + 'sdk.json'))
    if not isinstance(metadata, dict) or any(metadata.get(k) != sdk.get(k) for k in ['name', 'version']):
        raise ValueError(f'{component} SDK metadata identity mismatch')
    for name, record in inputs.items():
        original = manifest['files'].get(name.removeprefix(prefix))
        if (not isinstance(original, dict) or original.get('size') != record.get('bytes')
                or original.get('sha256') != record.get('sha256')):
            raise ValueError(f'{component} SDK source inventory mismatch: {name}')
    build = receipt.get('build')
    if (not isinstance(build, dict) or build.get('id') != component
            or build.get('format') != 'emscripten-es-module'):
        raise ValueError(f'Expected {component} WASM build identity')
    sources = records(build.get('sourceFiles'), component + ' build input')
    outputs = records(build.get('outputs'), component + ' build output')
    if not NATIVE_BUILD_INPUTS[component] <= sources.keys():
        raise ValueError(f'Expected complete {component} WASM build inputs')
    if component == 'ym2413':
        all_core = {name for name in manifest['files'] if name.startswith('vendor/ymfm/')
                    and name.endswith(('.cpp', '.h', '.ipp'))}
        if not all_core <= sources.keys():
            raise ValueError('Expected complete ym2413 ymfm core build inputs')
    for name, source in sources.items():
        target = prefix + name
        verify_record(source_root, source_hashes, source, target, 'size')
        if target not in inputs:
            raise ValueError(f'Missing {component} build source receipt: {target}')
    fingerprint = digest(json.dumps([
        {'path': item['path'], 'sha256': item['sha256'], 'size': item['size']}
        for item in build['sourceFiles']], separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
    if build.get('sourceFingerprint') != fingerprint:
        raise ValueError(f'{component} build source fingerprint mismatch')
    generated = receipt.get('generated')
    expected_outputs = {component + '_wasm.js', component + '_wasm.wasm'}
    if not isinstance(generated, dict) or set(generated) != expected_outputs or set(outputs) != expected_outputs:
        raise ValueError(f'Expected complete {component} WASM build outputs')
    for name, output in outputs.items():
        for base in ['generated/', 'js/generated/']:
            verify_record(destination, hashes, output, base + name, 'size')
            verify_record(destination, hashes, generated[name], base + name)
    return sdk


def validate_effects(source_root, source_hashes, destination, hashes):
    receipt = read_json(source_root / 'NATIVE-FX.json')
    if (not isinstance(receipt, dict) or type(receipt.get('schemaVersion')) is not int
            or receipt['schemaVersion'] != 1 or receipt.get('component') != 'native_audio_effect'):
        raise ValueError('Expected native Code effects source identity')
    inputs = records(receipt.get('inputs'), 'Code effects input')
    prefix = 'code-effects/'
    if set(inputs) != {prefix + name for name in FX_SOURCES}:
        raise ValueError('Expected complete Code effects sources, license and build recipe')
    for name, record in inputs.items():
        if record.get('sourcePath') != name.removeprefix(prefix):
            raise ValueError(f'Code effects original source identity mismatch: {name}')
        verify_record(source_root, source_hashes, record, name)
    generated = receipt.get('generated')
    if not isinstance(generated, dict) or set(generated) != {'native_audio_effect.wasm'}:
        raise ValueError('Expected Code effects WASM output receipt')
    verify_record(destination, hashes, generated['native_audio_effect.wasm'], 'js/native_audio_effect.wasm')
    proof = receipt.get('rebuildVerification')
    if proof is not None:
        fingerprint = digest(json.dumps([
            {'path': item['path'], 'sourcePath': item['sourcePath'],
             'bytes': item['bytes'], 'sha256': item['sha256']}
            for item in receipt['inputs']], separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
        if (not isinstance(proof, dict) or proof.get('byteExact') is not True
                or proof.get('sourceFingerprint') != fingerprint
                or not isinstance(proof.get('compiler'), dict)
                or proof['compiler'].get('command') != 'emcc'
                or not isinstance(proof['compiler'].get('version'), str)
                or not proof['compiler']['version']):
            raise ValueError('Code effects rebuild verification mismatch')
        verify_record(destination, hashes, proof.get('output'), 'js/native_audio_effect.wasm')
    if source_hashes[prefix + 'LICENSE'] != hashes['LICENSE']:
        raise ValueError('Code effects license differs from the package license')


def validate_supplement(destination, hashes, source_root):
    source_hashes = snapshot_tree(source_root)
    manifest = read_json(source_root / 'manifest.json')
    if (not isinstance(manifest, dict) or type(manifest.get('schemaVersion')) is not int
            or manifest['schemaVersion'] != 1
            or manifest.get('component') != 'smsgear-native-sources'):
        raise ValueError('Expected SMSGEAR native source manifest identity')
    inventory = records(manifest.get('files'), 'native source manifest')
    if set(inventory) != source_hashes.keys() - {'manifest.json'}:
        raise ValueError('Native source manifest inventory mismatch')
    for name, item in inventory.items():
        verify_record(source_root, source_hashes, item, name)
    psg = validate_native(source_root, source_hashes, destination, hashes, 'segapsg')
    fm = validate_native(source_root, source_hashes, destination, hashes, 'ym2413')
    if psg != fm:
        raise ValueError('SMSGEAR PSG and YM2413 use different SDK source identities')
    validate_effects(source_root, source_hashes, destination, hashes)


def validate_release(destination, hashes, native_sources=None):
    missing = REQUIRED - hashes.keys()
    if missing:
        raise ValueError('Expected SMSGEAR PSG + YM2413 Synth ZIP; missing: ' + ', '.join(sorted(missing)))
    validate_browser(destination, hashes)
    validate_supplement(destination, hashes, native_sources or ROOT / 'native-sources')


def unpack(archive, destination, native_sources=None):
    hashes, names, spellings = {}, set(), {}
    with zipfile.ZipFile(archive) as source:
        entries = []
        for entry in source.infolist():
            name = safe_name(entry.filename[:-1] if entry.is_dir() else entry.filename)
            folded = name.casefold()
            mode = entry.external_attr >> 16
            if (folded in names or stat.S_ISLNK(mode)
                    or (stat.S_IFMT(mode) and not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)))):
                raise ValueError(f'Unsafe or duplicate ZIP entry: {name}')
            names.add(folded)
            for index in range(1, len(PurePosixPath(name).parts) + 1):
                prefix = '/'.join(PurePosixPath(name).parts[:index])
                previous = spellings.setdefault(prefix.casefold(), prefix)
                if previous != prefix:
                    raise ValueError(f'Unsafe case-colliding ZIP path: {name}')
            entries.append((entry, name))
        for entry, name in entries:
            if entry.is_dir():
                continue
            data = source.read(entry)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            hashes[name] = digest(data)
    validate_release(destination, hashes, native_sources)
    return hashes


LOCAL_REQUIRED = {'index.html', 'synth-smsgear/synth.js'}
LOCAL_MANIFEST = 'local-changes.json'


def safe_name(name):
    if not isinstance(name, str) or not name or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError('Expected a safe relative release file path')
    path = PurePosixPath(name)
    if (path.is_absolute() or name != path.as_posix() or '..' in path.parts
            or name == '.' or '\\' in name or ':' in name
            or any(part.endswith(('.', ' ')) or re.fullmatch(
                r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.IGNORECASE)
                for part in path.parts)):
        raise ValueError(f'Unsafe release path: {name}')
    return name


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def snapshot_tree(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f'Expected a real release/source directory: {directory}')
    hashes = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not release files: {path.relative_to(directory)}')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f'Expected a regular release file: {path.relative_to(directory)}')
        name = safe_name(path.relative_to(directory).as_posix())
        hashes[name] = digest(path.read_bytes())
    return hashes


def snapshot_dist(root):
    return snapshot_tree(root / 'dist')


def baseline_files(lock):
    files = lock.get('files') if isinstance(lock, dict) else None
    if not isinstance(files, dict) or not valid_hash(lock.get('sha256')):
        raise ValueError('Expected a pinned release SHA-256 and file hashes')
    for name, sha in files.items():
        safe_name(name)
        if not valid_hash(sha):
            raise ValueError(f'Invalid imported file SHA-256: {name}')
    return files


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON receipt property: {key}')
        result[key] = value
    return result


def local_changes(root, lock):
    path = root / LOCAL_MANIFEST
    if path.is_symlink():
        raise ValueError('Local change manifest must not be a symlink')
    if not path.exists():
        return None
    baseline = baseline_files(lock)
    manifest = read_json(path)
    if (not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'baseSha256', 'files'}
            or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1
            or not isinstance(manifest['files'], dict)):
        raise ValueError('Invalid local change manifest schema')
    if manifest['baseSha256'] != lock['sha256']:
        raise ValueError('Local changes belong to a different imported release; import and reapply edits')
    for name, sha in manifest['files'].items():
        safe_name(name)
        if sha is None:
            if name not in baseline:
                raise ValueError(f'Cannot delete an unknown imported file: {name}')
        elif not valid_hash(sha):
            raise ValueError(f'Invalid local file SHA-256: {name}')
    return manifest


def require_entries(files):
    missing = LOCAL_REQUIRED - files.keys()
    if missing:
        raise ValueError('Local edits must keep application entry files: ' + ', '.join(sorted(missing)))


def record_local_changes(root):
    lock = read_json(root / 'release.lock.json')
    baseline = baseline_files(lock)
    local_changes(root, lock)  # Reject stale or malformed records before replacing them.
    actual = snapshot_dist(root)
    require_entries(actual)
    changes = {name: actual.get(name) for name in sorted(baseline.keys() | actual.keys())
               if actual.get(name) != baseline.get(name)}
    manifest = {'schemaVersion': 1, 'baseSha256': lock['sha256'], 'files': changes}
    destination = root / LOCAL_MANIFEST
    if changes:
        with tempfile.TemporaryDirectory(prefix='.local-edits-', dir=root) as temporary:
            staging = Path(temporary) / LOCAL_MANIFEST
            staging.write_bytes((json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + '\n').encode('utf-8'))
            staging.replace(destination)
        print(f"Recorded {len(changes)} local changes over Synth {lock['version']}; imported release hashes kept")
    else:
        destination.unlink(missing_ok=True)
        print(f"Restored imported Synth {lock['version']}; no local changes")
    return manifest


def check(root):
    lock = read_json(root / 'release.lock.json')
    actual = snapshot_dist(root)
    manifest = local_changes(root, lock)
    expected = dict(baseline_files(lock))
    if manifest is not None:
        for name, sha in manifest['files'].items():
            if sha is None:
                expected.pop(name)
            else:
                expected[name] = sha
        require_entries(actual)
    if actual != expected:
        raise ValueError('dist has unrecorded changes; run npm run record:edits or import the pinned ZIP again')
    if BROWSER_RECEIPT in lock['files']:
        pinned_sources = lock.get('nativeSourceManifestSha256')
        if (not valid_hash(pinned_sources) or pinned_sources != digest(
                (root / 'native-sources/manifest.json').read_bytes())):
            raise ValueError('Native source manifest differs from the imported release lock')
        # Local Web edits remain explicit; the original native outputs must
        # still correspond to the distributable rebuild sources.
        validate_supplement(root / 'dist', actual, root / 'native-sources')
    return lock


def prepare_app_version(root, version):
    # Keep each checkout self-contained and support tests loading this module
    # directly by filename, without relying on the caller's Python path.
    spec = importlib.util.spec_from_file_location('app_version', Path(__file__).with_name('app_version.py'))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper.prepare_version_update(root, version)


def import_release(root, archive, version=None):
    version_update = prepare_app_version(root, version) if version is not None else None
    if not archive.is_file():
        raise FileNotFoundError(f'Synth release ZIP not found: {archive}')
    sha = digest(archive.read_bytes())
    previous = root / 'release.lock.json'
    for target in [previous, root / LOCAL_MANIFEST]:
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError(f'Expected a regular import receipt: {target}')
    destination = root / 'dist'
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise ValueError('Expected a real dist directory before import')
    old_receipt = previous.read_bytes() if previous.exists() else None
    old_lock = json.loads(old_receipt, object_pairs_hook=unique_object) if old_receipt is not None else {}
    if not isinstance(old_lock, dict):
        raise ValueError('Expected a release lock object')
    release_version = old_lock.get('version') if old_lock.get('sha256') == sha else f'sha256-{sha[:12]}'
    local_manifest = root / LOCAL_MANIFEST
    old_local = local_manifest.read_bytes() if local_manifest.exists() else None
    with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temporary:
        staging = Path(temporary) / 'dist'
        staging.mkdir()
        hashes = unpack(archive, staging, root / 'native-sources')
        lock = {'version': release_version, 'archive': archive.name, 'sha256': sha, 'files': hashes}
        if BROWSER_RECEIPT in hashes:
            lock['nativeSourceManifestSha256'] = digest((root / 'native-sources/manifest.json').read_bytes())
        destination = root / 'dist'
        backup = Path(temporary) / 'previous-dist'
        if destination.exists():
            destination.rename(backup)
        try:
            staging.rename(destination)
            staged_lock = Path(temporary) / 'release.lock.json'
            staged_lock.write_bytes((json.dumps(lock, indent=2, sort_keys=True, ensure_ascii=False) + '\n').encode('utf-8'))
            staged_lock.replace(previous)
            local_manifest.unlink(missing_ok=True)
            if version_update is not None:
                version_update.apply()
        except BaseException:
            if destination.exists():
                shutil.rmtree(destination)
            if backup.exists():
                backup.rename(destination)
            if old_receipt is None:
                previous.unlink(missing_ok=True)
            else:
                previous.write_bytes(old_receipt)
            if old_local is not None:
                local_manifest.write_bytes(old_local)
            raise
    print(f'Imported {release_version}: {len(hashes)} files, SHA256 {sha}')
    if version_update is not None:
        print(f'App version set to {version_update.version}; dependency versions preserved')
    return lock

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip', nargs='?', type=Path, help='Path to the Synth release ZIP')
    parser.add_argument('--version', help='Set the desktop app version (X.Y.Z), independently of the ZIP name')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--check', action='store_true')
    actions.add_argument('--record-local-changes', action='store_true')
    args = parser.parse_args()
    if (args.check or args.record_local_changes) and (args.zip is not None or args.version is not None):
        parser.error('choose a ZIP import with optional --version, --check, or --record-local-changes')
    if not args.check and not args.record_local_changes and args.zip is None:
        parser.error('provide the ZIP path: npm run import:release -- ./xxx.zip')
    try:
        if args.check:
            lock = check(ROOT)
            manifest = local_changes(ROOT, lock)
            if manifest is None:
                print(f"Verified Synth {lock['version']}: {len(lock['files'])} files")
            else:
                print(f"Verified locally edited Synth {lock['version']}: {len(manifest['files'])} recorded local changes over SHA256 {lock['sha256']}")
        elif args.record_local_changes:
            record_local_changes(ROOT)
        else:
            import_release(ROOT, args.zip, version=args.version)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
