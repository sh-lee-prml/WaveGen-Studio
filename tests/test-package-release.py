"""Release metadata tests: no model parsing, ZIP rebuilding, GPU or network."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_release', ROOT / 'scripts/package-release.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
VERSION = {'version': '0.1.0-beta.1', 'display_version': '0.1 (beta)', 'repository': 'sh-lee-prml/WaveGen-Studio'}
DESCRIPTOR = {'repository': 'LeeSangHoon/WaveGen', 'revision': 'a'*40, 'sha256': 'b'*64,
              'url': 'https://huggingface.co/LeeSangHoon/WaveGen/resolve/' + 'a'*40 + '/config.json'}

def assets():
    return [{'id': name, 'name': f"WaveGen-Studio-{VERSION['version']}-{name}-windows-x64.zip",
             'url': 'https://example.invalid/old', 'sha256': 'c'*64, 'size': 12,
             'required': name in ('app', 'runtime', 'flash'), 'files': {name+'.txt': 'd'*64}} for name in package.PACKS]

class ReleasePackaging(unittest.TestCase):
    def test_pinned_descriptor(self):
        self.assertEqual(package.validate_model_config(DESCRIPTOR), DESCRIPTOR)
        for key, value in [('repository', 'other/repo'), ('revision', 'main'), ('sha256', 'wrong'), ('url', DESCRIPTOR['url'].replace('https:', 'http:'))]:
            with self.subTest(field=key), self.assertRaises(ValueError):
                package.validate_model_config({**DESCRIPTOR, key: value})

    def test_release_requires_configuration(self):
        with self.assertRaises(ValueError):
            package.assemble_manifest(VERSION, assets(), None)

    def test_models_use_pinned_original_hub_app_stays_github(self):
        result = package.assemble_manifest(VERSION, assets(), DESCRIPTOR)
        for row in result['assets']:
            if row['id'] in package.MODELS:
                self.assertEqual(row['url'], DESCRIPTOR['url'].removesuffix('config.json') + 'studio/v0.1.0-beta.1/' + row['name'])
            else:
                self.assertTrue(row['url'].startswith('https://github.com/sh-lee-prml/WaveGen-Studio/releases/'))

    def test_app_refresh_keeps_hf_and_model_records(self):
        original = package.assemble_manifest(VERSION, assets(), DESCRIPTOR)
        incoming = copy.deepcopy(original['assets'])
        incoming[0]['sha256'] = 'e'*64
        retained = package.resolve_model_config(None, original, VERSION)
        updated = package.assemble_manifest(VERSION, incoming, retained)
        self.assertEqual(updated['model_config'], original['model_config'])
        self.assertEqual(updated['assets'][1:], original['assets'][1:])
        self.assertNotEqual(updated['assets'][0]['sha256'], original['assets'][0]['sha256'])

    def test_version_mismatch_rejected(self):
        original = package.assemble_manifest(VERSION, assets(), DESCRIPTOR)
        with self.assertRaises(ValueError):
            package.resolve_model_config(None, original, {**VERSION, 'version': '0.2.0'})
        bad = assets();bad[2]['name'] = 'old-release.zip'
        with self.assertRaises(ValueError):
            package.assemble_manifest(VERSION, bad, DESCRIPTOR)

    def test_new_application_reuses_exact_binary_components(self):
        previous = package.assemble_manifest(VERSION, assets(), DESCRIPTOR)
        version = {**VERSION, 'version': '0.2.0-beta.1', 'display_version': '0.2 (beta)'}
        app = {**previous['assets'][0], 'name': 'WaveGen-Studio-0.2.0-beta.1-app-windows-x64.zip'}
        updated = package.assemble_app_update(version, app, previous)
        self.assertEqual(updated['assets'][1:], previous['assets'][1:])
        self.assertEqual(updated['model_config'], previous['model_config'])
        self.assertEqual(updated['model_pack_version'], previous['version'])
        self.assertEqual(updated['version'], version['version'])
        with self.assertRaises(ValueError):
            package.assemble_app_update(version, previous['assets'][0], previous)

    def test_invalid_or_duplicate_component_rejected(self):
        bad = assets();bad[4] = bad[3]
        with self.assertRaises(ValueError):
            package.assemble_manifest(VERSION, bad, DESCRIPTOR)
        bad = assets();bad[2]['files'] = {}
        with self.assertRaises(ValueError):
            package.assemble_manifest(VERSION, bad, DESCRIPTOR)

    def test_app_only_cli_does_not_rewrite_retained_archives(self):
        scratch = (ROOT/'test-output').resolve(); scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='pack-', dir=scratch) as temporary:
            root = Path(temporary).resolve()
            self.assertTrue(root.is_relative_to(scratch))
            output = root/'release'; output.mkdir()
            (root/'version.json').write_text(json.dumps(VERSION))
            original = package.assemble_manifest(VERSION, assets(), DESCRIPTOR)
            package.write_json(output/'manifest.json', original)
            for row in original['assets']:
                package.write_json(output/(row['id']+'-asset.json'), row)
                (output/row['name']).write_bytes(b'original ZIP sentinel')
            old_archives = {row['name']: (output/row['name']).read_bytes() for row in original['assets'][1:]}
            def fake_archive(pack_id, entries, args, version):
                self.assertEqual(pack_id, 'app')
                row = copy.deepcopy(original['assets'][0]);row['sha256'] = 'e'*64
                package.write_json(output/'app-asset.json', row)
                return row
            argv = ['package-release.py', '--source-package', str(root/'input'), '--output-dir', str(output), '--app-dir', str(root/'app'), '--packs', 'app']
            with patch.object(package, 'REPO', root), patch.object(package, 'archive', fake_archive), patch('sys.argv', argv):
                package.main()
            updated = json.loads((output/'manifest.json').read_text())
            self.assertEqual(updated['model_config'], DESCRIPTOR)
            self.assertEqual(updated['assets'][1:], original['assets'][1:])
            for name, payload in old_archives.items():
                self.assertEqual((output/name).read_bytes(), payload)

if __name__ == '__main__':
    unittest.main()
