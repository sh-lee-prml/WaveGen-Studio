"""Rebuild the native model graphs. Python is a developer tool, not an app dependency.

Run fetch_sources.py first. Each subprocess releases its GPU allocation before
the next model runs. Output contains runtime assets only; diagnostics stay in
the work directory. Export success is not a substitute for native parity tests.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CHECKPOINTS = {
    "flash": ("WaveGen_Flash/model.safetensors", "d4f1a949e8766f73f886bfb5cc26e9fe8eac643a182bdcb10263db5452a39f66"),
    "vspec": ("WaveGen_VSpec/model_1400000.safetensors", "98bd63f4c43522be792377c176fd2e95e591ec5dce69091b489f49559bad15b9"),
}

def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def commands(model: str, work: Path, fixtures: bool = False) -> list[list[str]]:
    """Pure command planner, also used by the CPU-only orchestration tests."""
    directory = HERE / model
    raw, compact = work / model / "raw", work / model / "compact"
    if model == "reuse":
        return [[sys.executable, str(directory / "export_reuse.py"), "--output", str(raw), "--device", "cuda"] + (["--audio-fixture"] if fixtures else [])]
    export = [sys.executable, str(directory / f"export_{model}.py"), "--output", str(raw), "--device", "cuda"]
    if model == "flash":
        export += ["--precision", "bf16"]
    if fixtures:
        export += ["--fixtures"]
    graph = compact / f"wavegen_{model}_step.onnx"
    result = [export,
        [sys.executable, str(directory / "compact_cast_weights.py"), "--source", str(raw), "--destination", str(compact)],
        [sys.executable, str(directory / "remove_sequence_ops.py"), str(graph)]]
    if model == "vspec":
        graph = graph.with_stem(graph.stem + "_optimized")
        for name, suffix, extra in (
            ("promote_opmath.py", "_opmath_dropout", ["--dropout"]),
            ("promote_activations.py", "_activations", []),
            ("fuse_linear_bias.py", "_gemm", []),
            ("use_attention_operator.py", "_attention23", []),
        ):
            result.append([sys.executable, str(directory / name), str(graph), *extra])
            graph = graph.with_stem(graph.stem + suffix)
    return result

def copy_runtime(model: str, work: Path, output: Path) -> None:
    import onnx
    raw, compact = work / model / "raw", work / model / "compact"
    destination = output if model == "flash" else output / model
    destination.mkdir(parents=True, exist_ok=True)
    if model == "reuse":
        names = ["reuse.onnx", "LICENSE-OpenMDW-1.1.txt", "LICENSE-Mamba-Apache-2.0.txt"]
        for name in names:
            shutil.copyfile(raw / name, destination / name)
        info = json.loads((raw / "reuse_contract.json").read_text(encoding="utf-8"))
        for key in ("scan_fixtures", "audio_fixture", "elapsed_seconds"):
            info.pop(key, None)
        (destination / "reuse_contract.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
        return
    base = f"wavegen_{model}_step"
    suffix = "_optimized" if model == "flash" else "_optimized_opmath_dropout_activations_gemm_attention23"
    graph = destination / (base + ".onnx")
    shutil.copyfile(compact / (base + suffix + ".onnx"), graph)
    for name in (base + ".onnx.data", "mel_filter.f32", "hann_window.f32", "vocab.txt"):
        shutil.copyfile(compact / name, destination / name)
    for name in ("frontend_precision.txt", "frontend_precision.json"):
        shutil.copyfile(HERE / name, destination / name)
    if model == "vspec":
        shutil.copyfile(compact / "timesteps.f32", destination / "timesteps.f32")
    proto = onnx.load(str(graph), load_external_data=False)
    props = {value.key: value.value for value in proto.metadata_props}
    props.update(model_id=model, frontend_precision="BF16", euler_precision="FP32")
    onnx.helper.set_model_props(proto, props)
    onnx.save_model(proto, str(graph))
    onnx.checker.check_model(str(graph), full_check=True)
    info = json.loads((compact / "model_contract.json").read_text(encoding="utf-8"))
    for key in ("started_at_utc", "elapsed_seconds", "wrapper_parity", "fixture_frames", "fixture_long_frames"):
        info.pop(key, None)
    info["onnx"] = {"file": graph.name, "sha256": digest(graph), "external_file": base + ".onnx.data"}
    info["numerical_equivalence"] = "Released model and sampler policy; cross-runtime floating-point differences remain. Not bit-identical to PyTorch. Validate regenerated exports before release."
    (destination / "model_contract.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="+", choices=("flash", "vspec", "reuse"), default=["flash", "vspec", "reuse"])
    parser.add_argument("--work-directory", type=Path, default=ROOT / "build/export")
    parser.add_argument("--output-directory", type=Path, default=ROOT / "build/exported-models")
    parser.add_argument("--fixtures", action="store_true", help="Generate developer diagnostics using the licensed Mira reference, never user audio")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without importing GPU packages, reading checkpoints or writing files")
    args = parser.parse_args()
    if args.work_directory.resolve() == args.output_directory.resolve():
        parser.error("Work and runtime output directories must be separate")
    repository = Path(os.environ.get("WAVEGEN_REPOSITORY", ROOT / "upstream/WaveGen"))
    for model in dict.fromkeys(args.models):
        if not args.dry_run and model in CHECKPOINTS:
            filename, expected = CHECKPOINTS[model]
            checkpoint = repository / "ckpts" / filename
            if not checkpoint.is_file() or digest(checkpoint) != expected:
                raise RuntimeError(f"Pinned checkpoint missing or hash mismatch: {filename}; run fetch_sources.py")
        for command in commands(model, args.work_directory.resolve(), args.fixtures):
            print(subprocess.list2cmdline(command), flush=True)
            if not args.dry_run:
                subprocess.run(command, check=True)
        if not args.dry_run:
            copy_runtime(model, args.work_directory.resolve(), args.output_directory.resolve())
    if not args.dry_run:
        print(f"Runtime model files: {args.output_directory}. Perform native validation before release.")

if __name__ == "__main__":
    main()
