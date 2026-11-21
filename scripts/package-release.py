"""Build allowlisted, private-data-free release packs (Python is build-time only).

Exported model graphs are repacked without exporter stack traces or local paths.
Tensor data and executable graph operations are not changed. The model directory
must contain the final native-compatible exports, not raw training checkpoints.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import zipfile

REPO = Path(__file__).resolve().parents[1]
RUNTIME = [
    'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll',
    'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll',
    'nvrtc64_120_0.dll', 'nvrtc-builtins64_128.dll',
    'cudnn64_9.dll', 'cudnn_adv64_9.dll', 'cudnn_cnn64_9.dll',
    'cudnn_engines_precompiled64_9.dll', 'cudnn_engines_runtime_compiled64_9.dll',
    'cudnn_graph64_9.dll', 'cudnn_heuristic64_9.dll', 'cudnn_ops64_9.dll',
]
RUNTIME_NOTICES = [
    'ONNX-Runtime-LICENSE.txt', 'ONNX-Runtime-ThirdPartyNotices.txt',
    'ONNX-Runtime-Privacy.md', 'NVIDIA-CUDA-12.8-EULA.html',
    'NVIDIA-cuDNN-9.10.2-EULA.html', 'NVIDIA-cuDNN-9.10.2-Notices.html',
    'NVIDIA-cuDNN-9.10.2-Acknowledgements.html',
]
MODEL_NOTICES = ['WaveGen-Code-MIT.txt', 'WaveGen-Model-CC-BY-NC-4.0.txt',
                 'CC-BY-NC-4.0-Legal-Code.txt', 'WaveGen-ThirdPartyNotices.md']
FRONTEND = ['frontend_precision.txt', 'hann_window.f32', 'mel_filter.f32', 'vocab.txt']
PRIVATE_PATH = re.compile(r'(?i)(?:[a-z]:[\\/]|/(?:users|home)/|\.codex[\\/])')
DROP_CONTRACT = {'started_at_utc', 'torch_version', 'elapsed_seconds',
    'fixture_frames', 'fixture_long_frames', 'scan_fixtures', 'audio_fixture',
    'wrapper_parity', 'original_export_metadata', 'checkpoint_file', 'source_hashes',
    'numerical_equivalence', 'onnx_metadata', 'frontend_policy_file'}
PACKS = ('app', 'runtime', 'flash', 'vspec', 'reuse')
MODELS = frozenset(('flash', 'vspec', 'reuse'))


def validate_model_config(value: dict) -> dict:
    """The GitHub manifest pins the genuine HF configuration, not a count ping."""
    required = {'repository', 'revision', 'url', 'sha256'}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError('Model configuration descriptor must contain repository, revision, url, and sha256')
    if value['repository'] != 'LeeSangHoon/WaveGen':
        raise ValueError('Model configuration must use the original LeeSangHoon/WaveGen repository')
    if not isinstance(value['revision'], str) or not re.fullmatch(r'[a-f0-9]{40}', value['revision']):
        raise ValueError('Model configuration revision must be a full lowercase commit SHA')
    if not isinstance(value['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256']):
        raise ValueError('Model configuration needs a lowercase SHA256')
    expected = f"https://huggingface.co/{value['repository']}/resolve/{value['revision']}/config.json"
    if value['url'] != expected:
        raise ValueError('Model configuration URL must match its pinned repository and revision')
    return dict(value)


def resolve_model_config(path: Path | None, previous_manifest: dict | None, version: dict) -> dict | None:
    if path is not None:
        return validate_model_config(json.loads(path.read_text(encoding='utf-8-sig')))
    if previous_manifest is not None and previous_manifest.get('model_config') is not None:
        if previous_manifest.get('version') != version['version'] or previous_manifest.get('repository') != version['repository']:
            raise ValueError('A previous release configuration cannot be reused for a different release; pass --model-config')
        return validate_model_config(previous_manifest['model_config'])
    return None


def model_archive_url(model_config: dict, version: dict, name: str) -> str:
    # This is the same versioned relative path stored in the HF config assets.
    # The installer reads and verifies that configuration before downloading.
    return f"https://huggingface.co/{model_config['repository']}/resolve/{model_config['revision']}/studio/v{version['version']}/{name}"


def assemble_manifest(version: dict, assets: list[dict], model_config: dict | None) -> dict:
    if model_config is None:
        raise ValueError('A publishable release requires --model-config descriptor.json (or a matching existing HF-linked manifest)')
    model_config = validate_model_config(model_config)
    if len(assets) != len(PACKS) or {asset.get('id') for asset in assets} != set(PACKS):
        raise ValueError('A release manifest requires exactly one of each app/runtime/flash/vspec/reuse component')
    output = []
    for original in assets:
        asset = copy.deepcopy(original)
        expected_name = f"WaveGen-Studio-{version['version']}-{asset['id']}-windows-x64.zip"
        if asset.get('name') != expected_name:
            raise ValueError(f"Stale component record belongs to another release: {asset['id']}")
        if not re.fullmatch(r'[a-f0-9]{64}', str(asset.get('sha256', ''))) or type(asset.get('size')) is not int or asset['size'] <= 0:
            raise ValueError(f"Invalid component hash/size: {asset['id']}")
        if not isinstance(asset.get('files'), dict) or not asset['files']:
            raise ValueError(f"Missing component file hashes: {asset['id']}")
        for name, digest in asset['files'].items():
            safe_name(name)
            if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
                raise ValueError(f"Invalid component file checksum: {name}")
        if asset['id'] in MODELS:
            asset['url'] = model_archive_url(model_config, version, expected_name)
        else:
            asset['url'] = f"https://github.com/{version['repository']}/releases/download/v{version['version']}/{expected_name}"
        output.append(asset)
    return {'schema_version': 1, 'version': version['version'], 'display_version': version['display_version'],
            'repository': version['repository'], 'tag': 'v' + version['version'],
            'model_config': model_config, 'assets': output}


def assemble_app_update(version: dict, app: dict, previous: dict) -> dict:
    """Publish just the new application; retain pinned URLs and hashes for binary dependencies."""
    if previous.get('repository') != version['repository'] or previous.get('schema_version') != 1:
        raise ValueError('Expected a Studio release manifest from the same repository')
    if previous.get('version') == version['version'] or app.get('id') != 'app':
        raise ValueError('An application update needs a new version and a new app record')
    if app.get('name') != f"WaveGen-Studio-{version['version']}-app-windows-x64.zip":
        raise ValueError('New application archive does not match version.json')
    assets = previous['assets']
    if len(assets) != len(PACKS) or {a['id'] for a in assets} != set(PACKS):
        raise ValueError('Incomplete source release manifest')
    return {
        'schema_version': 1, **version, 'tag': 'v' + version['version'],
        'model_config': validate_model_config(previous['model_config']),
        'model_pack_version': previous.get('model_pack_version', previous['version']),
        'assets': [app if row['id'] == 'app' else row for row in assets],
    }


def sha(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')


def strip_graph_annotations(message, is_model=False):
    """Only remove protobuf fields that describe, rather than execute, a graph."""
    fields = message.DESCRIPTOR.fields_by_name
    if 'doc_string' in fields:
        message.ClearField('doc_string')
    if 'metadata_props' in fields and not is_model:
        message.ClearField('metadata_props')
    for field, value in list(message.ListFields()):
        if field.message_type is not None:
            if field.is_repeated:
                for item in value:
                    strip_graph_annotations(item)
            else:
                strip_graph_annotations(value)


def clean_graph(source: Path, target: Path) -> dict:
    import onnx
    model = onnx.load(str(source), load_external_data=False)
    identity = {entry.key: entry.value for entry in model.metadata_props}
    assert all(not PRIVATE_PATH.search(v) for v in identity.values()), 'Private model metadata'
    strip_graph_annotations(model, is_model=True)
    # External tensor locations must remain sibling filenames, never host paths.
    for tensor in model.graph.initializer:
        for entry in tensor.external_data:
            if entry.key == 'location':
                assert entry.value == Path(entry.value).name and not PRIVATE_PATH.search(entry.value)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(model.SerializeToString())
    assert identity == {entry.key: entry.value for entry in model.metadata_props}
    return {'file': source.name, 'sha256': sha(target), 'bytes': target.stat().st_size,
            'ir_version': model.ir_version, 'node_count': len(model.graph.node),
            'opsets': {entry.domain or 'ai.onnx': entry.version for entry in model.opset_import}}


def clean_contract(source: Path, target: Path, graph_info: dict) -> None:
    data = json.loads(source.read_text(encoding='utf-8'))
    result = {key: value for key, value in data.items() if key not in DROP_CONTRACT}
    result['onnx'] = graph_info
    result['publication_note'] = 'Exporter annotations and private validation fixtures omitted; graph operations and weights unchanged.'
    text = json.dumps(result, ensure_ascii=False)
    assert not PRIVATE_PATH.search(text), 'Local path survived contract sanitization'
    write_json(target, result)


def safe_name(value: str) -> str:
    assert '\\' not in value and not value.startswith('/') and ':' not in value
    assert all(part not in {'', '.', '..'} for part in value.split('/'))
    assert value.split('/')[0].lower() not in {'data', 'backups', 'downloads', '.git'}
    return value


def archive(pack_id: str, entries: dict[str, Path], args, version: dict) -> dict:
    name = f"WaveGen-Studio-{version['version']}-{pack_id}-windows-x64.zip"
    destination = args.output_dir/name
    assert entries and len({p.lower() for p in entries}) == len(entries)
    hashes = {}
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as bundle:
        for name_in_zip, source in sorted(entries.items()):
            safe_name(name_in_zip)
            assert source.is_file(), source
            hashes[name_in_zip] = sha(source)
            info = zipfile.ZipInfo(name_in_zip, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info._compresslevel = 1
            info.external_attr = 0o100644 << 16
            with source.open('rb') as incoming, bundle.open(info, 'w', force_zip64=True) as outgoing:
                while block := incoming.read(8*1024*1024):
                    outgoing.write(block)
    assert destination.stat().st_size < 2*1024**3, 'A GitHub release asset must be under2GiB'
    url = model_archive_url(args.model_config, version, name) if pack_id in MODELS and args.model_config else (
        None if pack_id in MODELS else f"https://github.com/{version['repository']}/releases/download/v{version['version']}/{name}")
    row = {'id': pack_id, 'name': name, 'url': url,
           'sha256': sha(destination), 'size': destination.stat().st_size,
           'required': pack_id in {'app','runtime','flash'}, 'files': hashes}
    write_json(args.output_dir/(pack_id+'-asset.json'), row)
    print(json.dumps({k:v for k,v in row.items() if k!='files'}), flush=True)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-package', type=Path, required=True, help='Existing licensed runtime/models distribution; never copies its data/')
    parser.add_argument('--app-dir', type=Path, default=REPO/'build/app')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--packs', nargs='+', choices=PACKS, default=list(PACKS))
    parser.add_argument('--model-config', type=Path, help='JSON descriptor pinning the original HF repository config; a same-version existing manifest is reused when omitted')
    parser.add_argument('--reuse-components-from', type=Path, help='Previous published manifest for an app-only release; preserves runtime and model archives, URLs, and hashes')
    args = parser.parse_args()
    args.output_dir = args.output_dir.resolve()
    assert args.output_dir != args.source_package.resolve() and not args.output_dir.is_relative_to(args.source_package.resolve())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    sanitized = args.output_dir/'sanitized'
    version = json.loads((REPO/'version.json').read_text(encoding='utf-8'))
    assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?',version['version'])
    previous_path = args.output_dir/'manifest.json'
    previous = json.loads(previous_path.read_text(encoding='utf-8')) if previous_path.exists() else None
    base_manifest = None
    if args.reuse_components_from:
        if args.packs != ['app'] or args.model_config:
            parser.error('--reuse-components-from requires --packs app and uses the previous model configuration')
        base_manifest = json.loads(args.reuse_components_from.read_text(encoding='utf-8-sig'))
    args.model_config = validate_model_config(base_manifest['model_config']) if base_manifest else resolve_model_config(args.model_config, previous, version)
    available = set(args.packs) | {name for name in PACKS if (args.output_dir/(name+'-asset.json')).exists()}
    if available == set(PACKS) and args.model_config is None:
        parser.error('Final release assembly requires --model-config descriptor.json; no archives were changed')
    for pack_id in args.packs:
        entries = {}
        if pack_id == 'runtime':
            entries.update({name:args.source_package/name for name in RUNTIME})
            entries.update({'licenses/'+name:args.source_package/'licenses'/name for name in RUNTIME_NOTICES})
            notice = sanitized/'RUNTIME_COMPONENTS.txt'
            notice.parent.mkdir(parents=True, exist_ok=True)
            notice.write_text('These runtime libraries are components of WaveGen Studio for use with its application functionality. They are not a standalone SDK distribution. NVIDIA and ONNX Runtime license terms in licenses/ apply. Microsoft Visual C++ Redistributable is a separate official Microsoft prerequisite; its binaries are not included.\n',encoding='utf-8')
            entries['RUNTIME_COMPONENTS.txt'] = notice
        elif pack_id in {'flash','vspec','reuse'}:
            folder = args.source_package/'model'/({'flash':'','vspec':'vspec','reuse':'reuse'}[pack_id])
            prefix = 'model/' + ('' if pack_id=='flash' else pack_id+'/')
            graph_name = {'flash':'wavegen_flash_step.onnx','vspec':'wavegen_vspec_step.onnx','reuse':'reuse.onnx'}[pack_id]
            graph_target = sanitized/prefix/graph_name
            graph_info = clean_graph(folder/graph_name,graph_target)
            entries[prefix+graph_name] = graph_target
            contract_name = 'reuse_contract.json' if pack_id=='reuse' else 'model_contract.json'
            contract_target = sanitized/prefix/contract_name
            clean_contract(folder/contract_name,contract_target,graph_info)
            entries[prefix+contract_name] = contract_target
            if pack_id!='reuse':
                for name in [*FRONTEND, graph_name+'.data', *(['timesteps.f32'] if pack_id=='vspec' else [])]:
                    entries[prefix+name] = folder/name
                entries.update({'licenses/'+name:args.source_package/'licenses'/name for name in MODEL_NOTICES})
            else:
                for name in ['LICENSE-Mamba-Apache-2.0.txt','LICENSE-OpenMDW-1.1.txt']:
                    entries[prefix+name] = folder/name
        else:
            for name in ['WaveGen Studio.exe','version.json','build-info.json']:
                entries[name] = args.app_dir/name
            for source_folder, installed_folder in [('web', 'studio_web'), ('presets', 'presets')]:
                folder = REPO/source_folder
                for path in folder.rglob('*'):
                    if path.is_file():
                        entries[installed_folder+'/'+path.relative_to(folder).as_posix()] = path
            for name in ['LICENSE','THIRD_PARTY_NOTICES.md','README.md','README_KO.md','CONTRIBUTING.md']:
                entries[name] = REPO/name
            for name in ['Install-WaveGen-Studio.cmd','Update-WaveGen-Studio.cmd','Launch-WaveGen-Studio.cmd',
                         'scripts/install.ps1','scripts/update.ps1','scripts/package-common.ps1']:
                entries[name] = REPO/name
            for folder in ['docs','licenses']:
                for path in (REPO/folder).rglob('*'):
                    if path.is_file():entries[path.relative_to(REPO).as_posix()] = path
        archive(pack_id,entries,args,version)
    assets = [json.loads((args.output_dir/(name+'-asset.json')).read_text()) for name in PACKS if (args.output_dir/(name+'-asset.json')).exists()]
    if base_manifest or len(assets)==5:
        if base_manifest:
            app = json.loads((args.output_dir/'app-asset.json').read_text())
            manifest = assemble_app_update(version, app, base_manifest)
        else:
            manifest = assemble_manifest(version, assets, args.model_config)
        # Refresh only metadata for retained packs. Their archives are not opened
        # or rewritten when --packs app refreshes the small application bundle.
        assets = manifest['assets']
        for asset in assets:
            write_json(args.output_dir/(asset['id']+'-asset.json'), asset)
        write_json(args.output_dir/'manifest.json', manifest)
        lines = [f"{entry['sha256']}  {entry['name']}" for entry in assets]
        lines.append(f"{sha(args.output_dir/'manifest.json')}  manifest.json")
        (args.output_dir/'SHA256SUMS.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')


if __name__ == '__main__':
    main()
