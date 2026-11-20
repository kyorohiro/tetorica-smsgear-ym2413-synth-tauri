"""SMSGEAR Web bytes and matching native-source provenance regressions."""
import contextlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_importer', ROOT / 'scripts/import_release.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def record(name, data, **extras):
    return {'path': name, 'bytes': len(data), 'sha256': importer.digest(data), **extras}


def release_files(text=b'official'):
    files = {name: b'fixture readable bytes\r\n' for name in importer.REQUIRED}
    for name in importer.HTML_ENTRIES:
        base = './synth-smsgear/' if name == 'index.html' else './'
        files[name] = (b'<!doctype html><title>Tetorica SMSGEAR Synth PSG + YM2413</title>\n'
                       + f'<link rel="stylesheet" href="{base}synth.css">\n'.encode()
                       + f'<script type="module" src="{base}synth.js"></script>\n'.encode()
                       + text + b'\n')
    for name in importer.BROWSER_ENTRIES:
        files[name] = b'// Original readable source\r\nexport const readable = true;\r\n'
    files['synth-smsgear/synth.js'] = b'import "../js/helper.js";\r\n// Unminified authored source.\r\n'
    files['js/helper.js'] = b'export const original = "source";\r\n'
    files['synth-smsgear/song_worklet.js'] = b'import factory from "../generated/segapsg_wasm.js";\n'
    names = sorted(importer.BROWSER_ENTRIES | {'js/helper.js'})
    modules = [record(name, files[name], sourcePath='docs/' + name, localImports=(
        ['../js/helper.js'] if name == 'synth-smsgear/synth.js' else
        ['../generated/segapsg_wasm.js'] if name == 'synth-smsgear/song_worklet.js' else [])) for name in names]
    files[importer.BROWSER_RECEIPT] = encoded({
        'inputs': ['docs/' + name for name in names], 'modules': modules,
        'entries': [item for item in modules if item['path'] in importer.BROWSER_ENTRIES],
        'version': 'dev', 'minified': False,
    })
    files['LICENSE'] = b'BSD-3-Clause source fixture\n'
    for component in ['segapsg', 'ym2413']:
        for extension in ['js', 'wasm']:
            data = (b'// Generated factory\n' if extension == 'js' else b'\0asm\x01\0\0\0') + component.encode()
            for prefix in ['generated/', 'js/generated/']:
                files[prefix + component + '_wasm.' + extension] = data
    files['js/native_audio_effect.wasm'] = b'\0asm\x01\0\0\0native-fx'
    return files


def native_files(web=None):
    web = web or release_files()
    result = {}
    source_names = set.union(*importer.NATIVE_BUILD_INPUTS.values()) | {'LICENSE', 'sdk.json'}
    original = {name: ('// Native source ' + name + '\n').encode() for name in source_names}
    original['LICENSE'] = web['LICENSE']
    original['sdk.json'] = encoded({'name': 'tetorica-soundchip-native', 'version': '1.2.3'})
    manifest = encoded({'name': 'tetorica-soundchip-native', 'version': '1.2.3', 'files': {
        name: {'size': len(data), 'sha256': importer.digest(data)} for name, data in original.items()}})
    pin = {'name': 'tetorica-soundchip-native', 'version': '1.2.3', 'manifestSha256': importer.digest(manifest)}
    for component in ['segapsg', 'ym2413']:
        prefix = component + '-sdk/'
        names = importer.NATIVE_BUILD_INPUTS[component] | {'LICENSE', 'sdk.json'}
        sources = [{'path': name, 'sha256': importer.digest(original[name]), 'size': len(original[name])}
                   for name in sorted(importer.NATIVE_BUILD_INPUTS[component])]
        build = {'id': component, 'format': 'emscripten-es-module', 'sourceFiles': sources,
                 'sourceFingerprint': importer.digest(json.dumps(sources, separators=(',', ':')).encode()),
                 'outputs': [{'path': component + '_wasm.' + ext,
                              'size': len(web['generated/' + component + '_wasm.' + ext]),
                              'sha256': importer.digest(web['generated/' + component + '_wasm.' + ext])}
                             for ext in ['js', 'wasm']]}
        result.update({prefix + name: original[name] for name in names})
        result[prefix + 'RELEASE-MANIFEST.json'] = manifest
        result[prefix + 'soundchip-sdk.json'] = encoded(pin)
        result[component.upper() + '.json'] = encoded({
            'schemaVersion': 1, 'component': component, 'sdk': pin, 'build': build,
            'inputs': [record(prefix + name, original[name]) for name in sorted(names)],
            'generated': {component + '_wasm.' + ext: record('', web['generated/' + component + '_wasm.' + ext])
                          for ext in ['js', 'wasm']},
        })
    effects = {name: (web['LICENSE'] if name == 'LICENSE' else ('// Effect source ' + name + '\n').encode())
               for name in importer.FX_SOURCES}
    result.update({'code-effects/' + name: data for name, data in effects.items()})
    result['NATIVE-FX.json'] = encoded({
        'schemaVersion': 1, 'component': 'native_audio_effect',
        'inputs': [record('code-effects/' + name, data, sourcePath=name) for name, data in effects.items()],
        'generated': {'native_audio_effect.wasm': record('', web['js/native_audio_effect.wasm'])},
    })
    result['manifest.json'] = encoded({'schemaVersion': 1, 'component': 'smsgear-native-sources',
        'files': [record(name, data) for name, data in sorted(result.items())]})
    return result



def refresh_native_inventory(files):
    files['manifest.json'] = encoded({'schemaVersion': 1, 'component': 'smsgear-native-sources',
        'files': [record(name, data) for name, data in sorted(files.items()) if name != 'manifest.json']})
    return files

def write_native(root, files=None):
    for name, data in (files or native_files()).items():
        target = root / 'native-sources' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def write_archive(path, files):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in files.items():
            archive.writestr(name, data)


class ImportTests(unittest.TestCase):
    def unpack(self, files, sources=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'release.zip'
            write_archive(archive, files)
            write_native(root, sources)
            hashes = importer.unpack(archive, root / 'out', root / 'native-sources')
            self.assertEqual({name: (root / 'out' / name).read_bytes() for name in hashes}, files)
            return hashes

    def test_preserves_every_web_byte_including_crlf(self):
        files = release_files()
        self.assertEqual(self.unpack(files), {name: importer.digest(data) for name, data in files.items()})

    def test_current_real_web_zip_matches_supplement_and_is_not_rewritten(self):
        candidates = [Path(os.environ['SMSGEAR_TEST_ZIP'])] if os.environ.get('SMSGEAR_TEST_ZIP') else [
            ROOT.parents[1] / 'build/smsgear-tauri-20261120/web/tetorica_smsgear_synth_dev_itch.zip',
            ROOT.parents[1] / 'release/tetorica_smsgear_synth_dev_itch.zip',
        ]
        archive = next((path for path in candidates if path.is_file()), None)
        if archive is None or not (ROOT / 'native-sources').is_dir():
            self.skipTest('real Web ZIP and native source kit are not present in this checkout')
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'out'
            hashes = importer.unpack(archive, output, ROOT / 'native-sources')
            with zipfile.ZipFile(archive) as source:
                expected = {entry.filename: source.read(entry) for entry in source.infolist() if not entry.is_dir()}
            self.assertEqual(set(hashes), set(expected))
            for name, data in expected.items():
                with self.subTest(path=name):
                    self.assertEqual((output / name).read_bytes(), data)

    def test_committed_release_and_supplement_validate_without_parent_checkout(self):
        # A fresh standalone repository clone includes dist and native-sources,
        # even when the optional original Web ZIP is unavailable.
        self.assertTrue((ROOT / 'dist/index.html').is_file(), 'committed Web distribution is required')
        self.assertTrue((ROOT / 'native-sources/manifest.json').is_file(), 'committed native source kit is required')
        with tempfile.TemporaryDirectory(prefix='smsgear standalone release ') as temporary:
            root = Path(temporary)
            shutil.copytree(ROOT / 'dist', root / 'dist')
            shutil.copytree(ROOT / 'native-sources', root / 'native-sources')
            shutil.copyfile(ROOT / 'release.lock.json', root / 'release.lock.json')
            actual = importer.snapshot_dist(root)
            importer.validate_release(root / 'dist', actual, root / 'native-sources')
            self.assertEqual(importer.check(root)['files'], actual)
            target = root / 'dist/synth-smsgear/synth.js'
            original = target.read_bytes()
            target.write_bytes(original + b'\n// unrecorded browser change\n')
            with self.assertRaisesRegex(ValueError, 'receipt mismatch'):
                importer.validate_release(root / 'dist', importer.snapshot_dist(root), root / 'native-sources')
            target.write_bytes(original)
            source = root / 'native-sources/ym2413-sdk/wasm/ym2413_wasm.cpp'
            source.write_bytes(source.read_bytes() + b'\n// unrecorded native source change\n')
            with self.assertRaisesRegex(ValueError, 'receipt mismatch'):
                importer.validate_release(root / 'dist', actual, root / 'native-sources')

    def test_minified_foreign_or_malformed_browser_receipts_are_rejected(self):
        for field, value in [('minified', True), ('modules', []), ('modules', [None]),
                             ('inputs', ['docs/foreign.js']), ('entries', [])]:
            files = release_files()
            receipt = json.loads(files[importer.BROWSER_RECEIPT]); receipt[field] = value
            files[importer.BROWSER_RECEIPT] = encoded(receipt)
            with self.subTest(field=field, value=value), self.assertRaises(ValueError): self.unpack(files)

    def test_entries_modules_and_dependency_graph_are_complete_and_match_bytes(self):
        for field, omitted in [('modules', 'js/helper.js'), ('modules', 'synth-smsgear/synth.js'),
                               ('entries', 'synth-smsgear/opll_worklet.js')]:
            files = release_files(); receipt = json.loads(files[importer.BROWSER_RECEIPT])
            receipt[field] = [item for item in receipt[field] if item['path'] != omitted]
            files[importer.BROWSER_RECEIPT] = encoded(receipt)
            with self.subTest(field=field, omitted=omitted), self.assertRaises(ValueError): self.unpack(files)
        for name in ['synth-smsgear/synth.js', 'js/helper.js', 'generated/ym2413_wasm.wasm',
                     'js/generated/segapsg_wasm.js', 'js/native_audio_effect.wasm']:
            for action in ['change', 'delete']:
                files = release_files()
                if action == 'delete': del files[name]
                else: files[name] = b'tampered'
                with self.subTest(name=name, action=action), self.assertRaises(ValueError): self.unpack(files)

    def test_forged_readable_source_identity_or_omitted_authored_import_is_rejected(self):
        for field, value in [('sourcePath', 'docs/other.js'), ('localImports', []),
                             ('localImports', ['../../escape.js'])]:
            files = release_files(); receipt = json.loads(files[importer.BROWSER_RECEIPT])
            entry = next(item for item in receipt['modules'] if item['path'] == 'synth-smsgear/synth.js')
            entry[field] = value
            files[importer.BROWSER_RECEIPT] = encoded(receipt)
            with self.subTest(field=field, value=value), self.assertRaises(ValueError): self.unpack(files)

    def test_html_requires_product_identity_module_stylesheet_and_local_assets(self):
        for name in importer.HTML_ENTRIES:
            for replacement in [b'<title>Unrelated app</title>',
                                release_files()[name].replace(b'type="module"', b'type="text/javascript"'),
                                release_files()[name].replace(b'synth.js', b'absent.js'),
                                release_files()[name] + b'<img src="./missing.webp">']:
                files = release_files(); files[name] = replacement
                with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)

    def test_complete_native_sources_build_receipts_and_licenses_are_verified(self):
        base = native_files()
        for name in ['segapsg-sdk/wasm/segapsg_wasm.cpp', 'ym2413-sdk/vendor/ymfm/ymfm_opl.cpp',
                     'ym2413-sdk/scripts/build_ym2413_wasm.sh', 'segapsg-sdk/LICENSE',
                     'code-effects/tetorica_src/native/audio_effect/gain.c',
                     'code-effects/scripts/build_native_audio_effect.sh', 'code-effects/LICENSE']:
            sources = dict(base); sources[name] = b'changed corresponding source'
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(release_files(), refresh_native_inventory(sources))
        for component in ['segapsg', 'ym2413']:
            for field in ['sourceFiles', 'outputs']:
                sources = dict(base); receipt = json.loads(sources[component.upper() + '.json'])
                receipt['build'][field][0]['sha256'] = '0' * 64
                sources[component.upper() + '.json'] = encoded(receipt)
                with self.subTest(component=component, field=field), self.assertRaises(ValueError): self.unpack(release_files(), refresh_native_inventory(sources))
            sources = dict(base); receipt = json.loads(sources[component.upper() + '.json'])
            receipt['inputs'] = receipt['inputs'][1:]
            sources[component.upper() + '.json'] = encoded(receipt)
            with self.subTest(component=component), self.assertRaises(ValueError): self.unpack(release_files(), refresh_native_inventory(sources))

    def test_source_manifests_and_pins_cannot_disagree(self):
        for name in ['segapsg-sdk/RELEASE-MANIFEST.json', 'ym2413-sdk/soundchip-sdk.json', 'ym2413-sdk/sdk.json']:
            sources = native_files(); sources[name] = b'{}'
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(release_files(), refresh_native_inventory(sources))

    def test_supplement_inventory_cannot_omit_or_add_unpinned_payload(self):
        for action in ['omit', 'add']:
            sources = native_files()
            if action == 'omit': sources.pop('ym2413-sdk/wasm/ym2413_wasm.cpp')
            else: sources['extra.c'] = b'unrecorded corresponding source'
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'inventory'):
                self.unpack(release_files(), sources)

    def test_duplicate_receipt_properties_and_native_records_are_rejected(self):
        sources = native_files(); receipt = json.loads(sources['YM2413.json'])
        receipt['inputs'].append(receipt['inputs'][0])
        sources['YM2413.json'] = encoded(receipt)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.unpack(release_files(), refresh_native_inventory(sources))
        files = release_files()
        files[importer.BROWSER_RECEIPT] = files[importer.BROWSER_RECEIPT].replace(
            b'"minified": false', b'"minified": false, "minified": false')
        with self.assertRaisesRegex(ValueError, 'Duplicate'): self.unpack(files)

    def test_unsafe_and_nonportable_zip_names_are_rejected(self):
        for name in ['../escape', '/absolute', './index.html', 'a/../../escape', 'a\\escape',
                     'C:/escape', 'a//b', 'bad\x00name', 'trailing.', 'trailing ', 'CON', 'AUX.txt']:
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack({name: b'bad'})

    def test_duplicate_names_case_collisions_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); archive = root / 'release.zip'
            for names in [('index.html', 'index.html'), ('index.html', 'INDEX.html')]:
                with zipfile.ZipFile(archive, 'w') as output:
                    output.writestr(names[0], b'a')
                    with contextlib.suppress(UserWarning):
                        import warnings
                        with warnings.catch_warnings():
                            warnings.simplefilter('ignore'); output.writestr(names[1], b'b')
                with self.subTest(names=names), self.assertRaisesRegex(ValueError, 'duplicate'):
                    importer.unpack(archive, root / 'out')
            with zipfile.ZipFile(archive, 'w') as output:
                info = zipfile.ZipInfo('link'); info.create_system = 3; info.external_attr = 0o120777 << 16
                output.writestr(info, '../../escape')
            with self.assertRaisesRegex(ValueError, 'Unsafe'): importer.unpack(archive, root / 'out')

    def test_import_replaces_atomically_keeps_label_for_same_zip_and_rejects_invalid_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); archive = root / 'anything.zip'
            write_native(root); first_files = release_files(b'first'); write_archive(archive, first_files)
            first = importer.import_release(root, archive)
            first['version'] = 'named-release'; (root / 'release.lock.json').write_bytes(encoded(first))
            self.assertEqual(importer.import_release(root, archive)['version'], 'named-release')
            replacement = release_files(b'second'); write_archive(archive, replacement)
            changed = importer.import_release(root, archive)
            self.assertEqual(changed['version'], 'sha256-' + changed['sha256'][:12])
            self.assertEqual((root / 'dist/index.html').read_bytes(), replacement['index.html'])
            before = (root / 'release.lock.json').read_bytes()
            write_archive(archive, {'index.html': b'wrong app'})
            with self.assertRaises(ValueError): importer.import_release(root, archive)
            self.assertEqual((root / 'release.lock.json').read_bytes(), before)
            self.assertEqual(importer.check(root), changed)
            self.assertNotIn(b'\r\n', before)

    def test_release_lock_pins_supplement_manifest_separately_from_web_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); archive = root / 'release.zip'; write_native(root)
            write_archive(archive, release_files()); lock = importer.import_release(root, archive)
            self.assertEqual(lock['nativeSourceManifestSha256'],
                             importer.digest((root / 'native-sources/manifest.json').read_bytes()))
            source_manifest = root / 'native-sources/manifest.json'
            source_manifest.write_bytes(source_manifest.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'manifest differs'): importer.check(root)

    def test_check_detects_unrecorded_changes_and_invalid_lock_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); archive = root / 'release.zip'; write_native(root)
            write_archive(archive, release_files()); importer.import_release(root, archive)
            (root / 'dist/extra.js').write_bytes(b'extra')
            with self.assertRaisesRegex(ValueError, 'unrecorded'): importer.check(root)
            (root / 'dist/extra.js').unlink()
            lock = json.loads((root / 'release.lock.json').read_bytes()); lock['sha256'] = 'not-a-hash'
            (root / 'release.lock.json').write_bytes(encoded(lock))
            with self.assertRaises(ValueError): importer.check(root)


if __name__ == '__main__':
    unittest.main()
