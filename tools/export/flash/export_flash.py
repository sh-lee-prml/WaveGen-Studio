"""Export WaveGen-Flash's single tensor-only DiT step for a native C++ host.

Python is used once to produce the ONNX graph, external weights, and frontend
constants. It is not required by the resulting ONNX Runtime C++ application.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
REPO = Path(os.environ.get("WAVEGEN_REPOSITORY", ROOT / "upstream/WaveGen")).resolve()
sys.path.insert(0, str(REPO / "src"))

import numpy as np
import torch
from torch import nn

INPUT_NAMES = ("wav_state", "mel_state", "wav_cond", "mel_cond", "text_ids", "time")
OUTPUT_NAMES = ("pred_wav", "pred_mel")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def dump_tensor(directory, name, tensor):
    array = tensor.detach().cpu().contiguous().numpy() if torch.is_tensor(tensor) else np.asarray(tensor)
    dtype = "<i8" if array.dtype == np.int64 else "<f4"
    path = directory / (name + (".i64" if dtype == "<i8" else ".f32"))
    array.astype(dtype, copy=False).tofile(path)
    return {"file": path.name, "shape": list(array.shape), "dtype": dtype,
            "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class FlashStep(nn.Module):
    """Exact released DiT math for one fully valid utterance, without masks.

The official wrapper's all-true mask creates a Python .item() text-length loop.
For batch=1 and frame-aligned all-valid samples, omitting that mask is exactly
equivalent and avoids freezing the exported duration to its example input.
Inputs retain FP32 states and INT64 vocabulary IDs, with IDs padded to F.
"""
    def __init__(self, transformer, precision="fp32"):
        super().__init__()
        self.net = transformer
        self.precision = precision

    def forward(self, wav_state, mel_state, wav_cond, mel_cond, text_ids, time):
        with torch.autocast("cuda", dtype=torch.bfloat16 if self.precision == "bf16" else torch.float16,
                            enabled=self.precision != "fp32"):
            wav, mel = self.forward_core(wav_state, mel_state, wav_cond, mel_cond, text_ids, time)
        return wav.float(), mel.float()

    def forward_core(self, wav_state, mel_state, wav_cond, mel_cond, text_ids, time):
        net = self.net
        frames = wav_state.shape[1]
        t = net.time_embed(time)
        text = net.text_embed(text_ids, frames, drop_text=False)
        value = net.input_embed(
            wav_state, wav_cond, mel_state, mel_cond, text,
            drop_audio_cond=False, audio_mask=None,
            inference_bottleneck_dropout=0.0,
        )
        rope = net.rotary_embed.forward_from_seq_len(frames)
        residual = value
        for block in net.transformer_blocks:
            value = block(value, t, mask=None, rope=rope)
        if net.long_skip_connection is not None:
            value = net.long_skip_connection(torch.cat((value, residual), dim=-1))
        mel_value = value
        for block in net.wav_ddt:
            value = block(value, t, mask=None, rope=rope)
        for block in net.mel_ddt:
            mel_value = block(mel_value, t, mask=None, rope=rope)
        pred_wav = net.proj_out(net.norm_out(value, t))
        pred_mel = net.mel_proj_out(net.mel_norm_out(mel_value, t))
        return pred_wav, pred_mel


def load_engine(device):
    from wavegen_flash import WaveGenFlash
    return WaveGenFlash.from_checkpoint(
        REPO / "ckpts/WaveGen_Flash/model.safetensors",
        REPO / "ckpts/WaveGen_Flash/vocab.txt",
        config=REPO / "ckpts/WaveGen_Flash/WaveGen_Flash.yaml",
        device=device, dtype="fp32", compute_final_mel=True,
    )


def example_inputs(frames, device):
    generator = torch.Generator(device=device).manual_seed(123)
    return (
        torch.randn((1, frames, 480), generator=generator, device=device),
        torch.randn((1, frames, 80), generator=generator, device=device),
        torch.randn((1, frames, 480), generator=generator, device=device),
        torch.randn((1, frames, 80), generator=generator, device=device),
        torch.arange(frames, device=device, dtype=torch.int64).remainder(100).reshape(1, frames),
        torch.tensor([0.25], dtype=torch.float32, device=device),
    )


def compare_wrapper(engine, wrapper, args):
    wav, mel, cond, mel_cond, ids, time_value = args
    samples = wav.shape[1] * 480
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16 if wrapper.precision == "bf16" else torch.float16,
                                               enabled=wrapper.precision != "fp32"):
        expected, _, _ = engine.model.transformer(
            x=wav.reshape(1, samples), cond=cond.reshape(1, samples),
            mel=mel, mel_cond=mel_cond, text=ids, time=time_value,
            mask=torch.ones((1, samples), dtype=torch.bool, device=wav.device),
            lens=torch.tensor([samples], dtype=torch.long, device=wav.device),
            cache=False, drop_audio_cond=False, drop_text=False,
            inference_bottleneck_dropout=0.0, predict_mel=True,
        )
        actual = wrapper(*args)
    errors = {}
    for name, want, got in zip(OUTPUT_NAMES, expected, actual):
        want = want.reshape_as(got).float()
        errors[name] = {"max_absolute": float((want - got).abs().max()),
                        "mean_absolute": float((want - got).abs().mean())}
        torch.testing.assert_close(got, want, rtol=1e-5, atol=1e-5)
    return errors


def export_frontend(engine, directory):
    frontend = engine.model.mel_f.mel_stft
    assets = {
        "mel_filter": dump_tensor(directory, "mel_filter", frontend.mel_scale.fb),
        "hann_window": dump_tensor(directory, "hann_window", frontend.spectrogram.window),
    }
    shutil.copyfile(REPO / "ckpts/WaveGen_Flash/vocab.txt", directory / "vocab.txt")
    return assets


def make_fixture(engine, wrapper, directory, name="fixture", gen_text="Here we generate something just for test."):
    """Export deterministic inputs and full four-step output for native parity."""
    from wavegen_v_spec.infer.utils_infer import _prepare_prompt
    from wavegen_v_spec.model.utils import convert_char_to_pinyin, list_str_to_idx
    fixture_dir = directory / name
    fixture_dir.mkdir(exist_ok=True)
    step_dir = fixture_dir / "step0"
    step_dir.mkdir(exist_ok=True)
    ref = ROOT / "presets/audio/mira.wav"
    ref_text = "I'm playing a single hand in what looks like a losing game."
    prompt, rms, prompt_samples, predicted_samples, combined_text = _prepare_prompt(
        ref, ref_text, gen_text, sample_rate=24000, frame_length=480, speed=1.0,
    )
    total = (predicted_samples + 479) // 480 * 480
    frames, prompt_frames = total // 480, prompt_samples // 480
    device = engine.device
    raw = torch.nn.functional.pad(prompt, (0, total - prompt_samples)).to(device)
    clean_wav = raw.reshape(1, frames, 480) * 9.0
    clean_mel = engine.model._mel_from_wav(raw, frames).float()
    cond = clean_wav.clone()
    cond[:, prompt_frames:] = 0
    mel_cond = clean_mel.clone()
    mel_cond[:, prompt_frames:] = 0
    tokens = convert_char_to_pinyin([combined_text])
    ids = list_str_to_idx(tokens, engine.model.vocab_char_map).to(device)
    ids = torch.nn.functional.pad(ids[:, :frames], (0, max(0, frames - ids.shape[1])), value=-1)
    generator = torch.Generator(device=device).manual_seed(0)
    initial_wav = torch.randn((1, total), generator=generator, device=device).reshape(1, frames, 480)
    # The release consumes a second Gaussian draw even at Mel temperature zero.
    initial_mel = torch.randn((1, frames, 80), generator=generator, device=device) * 0.0
    state_wav, state_mel = initial_wav.clone(), initial_mel.clone()
    assets = {
        "raw_reference_padded": dump_tensor(fixture_dir, "raw_reference_padded", raw),
        "noise_wav": dump_tensor(fixture_dir, "noise_wav", initial_wav),
        "clean_wav": dump_tensor(fixture_dir, "clean_wav", clean_wav),
        "clean_mel": dump_tensor(fixture_dir, "clean_mel", clean_mel),
        "wav_cond": dump_tensor(fixture_dir, "wav_cond", cond),
        "mel_cond": dump_tensor(fixture_dir, "mel_cond", mel_cond),
        "text_ids": dump_tensor(fixture_dir, "text_ids", ids),
    }
    grid = [0.0, 0.1, 0.25, 0.5, 1.0]
    with torch.inference_mode():
        for step in range(4):
            t, next_t = grid[step:step+2]
            state_wav[:, :prompt_frames] = (1 - t) * initial_wav[:, :prompt_frames] + t * clean_wav[:, :prompt_frames]
            state_mel[:, :prompt_frames] = (1 - t) * initial_mel[:, :prompt_frames] + t * clean_mel[:, :prompt_frames]
            time_value = torch.tensor([t], dtype=torch.float32, device=device)
            values = (state_wav, state_mel, cond, mel_cond, ids, time_value)
            if step == 0:
                assets.update({name: dump_tensor(step_dir, name, value)
                               for name, value in zip(INPUT_NAMES, values)})
            pred_wav, pred_mel = wrapper(*values)
            if step == 0:
                assets["pred_wav"] = dump_tensor(step_dir, "expected_pred_wav", pred_wav)
                assets["pred_mel"] = dump_tensor(step_dir, "expected_pred_mel", pred_mel)
            pred_wav[:, :prompt_frames] = clean_wav[:, :prompt_frames]
            pred_mel[:, :prompt_frames] = clean_mel[:, :prompt_frames]
            denom = torch.tensor([1 - t], dtype=torch.float32, device=device).clamp_min(0.02).reshape(1, 1, 1)
            dt = torch.tensor([next_t], dtype=torch.float32, device=device) - time_value
            state_wav = state_wav + dt.reshape(1, 1, 1) * ((pred_wav - state_wav) / denom)
            state_mel = state_mel + dt.reshape(1, 1, 1) * ((pred_mel - state_mel) / denom)
    suffix = state_wav.reshape(-1)[prompt_samples:predicted_samples] / 9.0
    if rms < 0.1:
        suffix = suffix * rms.to(device) / 0.1
    with torch.autocast("cuda", dtype=torch.bfloat16 if wrapper.precision == "bf16" else torch.float16,
                        enabled=wrapper.precision != "fp32"):
        expected_sr, expected_wave = engine.synthesize(ref, ref_text, gen_text, seed=0, compute_final_mel=True)
    expected_tensor = torch.from_numpy(expected_wave).to(device)
    parity = {"max_absolute": float((suffix - expected_tensor).abs().max()),
              "rms_difference": float(((suffix - expected_tensor) ** 2).mean().sqrt())}
    if not bool(torch.isfinite(suffix).all()):
        raise RuntimeError("Mixed-precision graph generated nonfinite waveform")
    if wrapper.precision == "fp32":
        torch.testing.assert_close(suffix, expected_tensor, rtol=2e-4, atol=2e-4)
    assets["output"] = dump_tensor(fixture_dir, "expected_output", suffix)
    import soundfile as sf
    sf.write(fixture_dir / "expected_output.wav", suffix.cpu().numpy(), 24000, subtype="PCM_16")
    sf.write(fixture_dir / "original_api_output.wav", expected_wave, expected_sr, subtype="PCM_16")
    shutil.copyfile(ref, fixture_dir / "reference.wav")
    metadata = dict(
        reference_text=ref_text, generation_text=gen_text, combined_text=combined_text,
        tokens=tokens[0], frames=frames, prompt_frames=prompt_frames,
        prompt_samples=prompt_samples, predicted_samples=predicted_samples,
        padded_samples=total, reference_rms=float(rms), seed=0,
        noise_source=f"PyTorch generator on {device}", precision=wrapper.precision, assets=assets,
        original_api_parity=parity, step_fixture_directory="step0",
        frontend_precision="FP32 filterbank for native frontend parity; official mixed API autocasts filterbank",
    )
    write_json(fixture_dir / "fixture.json", metadata)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE / "artifacts")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--precision", choices=("fp32", "bf16"), default="fp32")
    parser.add_argument("--exporter", choices=("dynamo", "legacy"), default="dynamo")
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("--max-frames", type=int, default=1500)
    parser.add_argument("--fixtures", action="store_true")
    parser.add_argument("--skip-export", action="store_true")
    parser.add_argument("--skip-wrapper-check", action="store_true")
    args = parser.parse_args()
    if args.precision != "fp32" and args.device != "cuda":
        parser.error("Mixed 16-bit export and references require --device cuda")
    for package in ("onnx", "onnxscript"):
        if not args.skip_export and importlib.util.find_spec(package) is None:
            raise RuntimeError(f"Export dependency missing: {package}. Install tools/export/requirements.txt in your export environment first.")
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    started = time.perf_counter()
    print("Loading official Flash FP32 EMA checkpoint...", flush=True)
    engine = load_engine(args.device)
    wrapper = FlashStep(engine.model.transformer, precision=args.precision).eval()
    example = example_inputs(args.frames, args.device)
    result = dict(
        started_at_utc=datetime.now(timezone.utc).isoformat(),
        torch_version=torch.__version__, source_revision="399ce751225001da75a62725f8827693a51bcc18",
        checkpoint_revision="43197aeeb6ca74de1a039f8ba0d7f02d26fc105e",
        checkpoint_sha256="d4f1a949e8766f73f886bfb5cc26e9fe8eac643a182bdcb10263db5452a39f66",
        precision=(f"FP32 source weights and {args.precision.upper()} CUDA autocast, FP32 graph inputs/outputs and Euler states"
                   if args.precision != "fp32" else "FP32 weights and inference; default Python BF16 is a separate numerical mode"),
        batch_size=1, frame_samples=480, sample_rate=24000, mel_channels=80,
        max_frames=args.max_frames, time_grid=[0, 0.1, 0.25, 0.5, 1],
        input_names=list(INPUT_NAMES), output_names=list(OUTPUT_NAMES),
        inputs={
            "wav_state": {"dtype": "float32", "shape": [1, "frames", 480]},
            "mel_state": {"dtype": "float32", "shape": [1, "frames", 80]},
            "wav_cond": {"dtype": "float32", "shape": [1, "frames", 480]},
            "mel_cond": {"dtype": "float32", "shape": [1, "frames", 80]},
            "text_ids": {"dtype": "int64", "shape": [1, "frames"], "padding": -1},
            "time": {"dtype": "float32", "shape": [1]},
        },
    )
    if not args.skip_wrapper_check:
        print("Checking tensor wrapper against original masked DiT...", flush=True)
        result["wrapper_parity"] = compare_wrapper(engine, wrapper, example)
        print(result["wrapper_parity"], flush=True)
    result["frontend_assets"] = export_frontend(engine, args.output)
    if args.fixtures:
        print("Generating four-step native validation fixture...", flush=True)
        fixture = make_fixture(engine, wrapper, args.output)
        result["fixture_frames"] = fixture["frames"]
        longer = make_fixture(engine, wrapper, args.output, name="fixture_long",
            gen_text="This native application generates speech directly on the graphics card without running Python.")
        result["fixture_long_frames"] = longer["frames"]
    if not args.skip_export:
        print(f"Exporting dynamic ONNX ({args.exporter}); weights use external data...", flush=True)
        output_path = args.output / "wavegen_flash_step.onnx"
        kwargs = dict(
            input_names=list(INPUT_NAMES), output_names=list(OUTPUT_NAMES),
            opset_version=18, external_data=True,
        )
        if args.exporter == "dynamo":
            frames = torch.export.Dim("frames", min=2, max=args.max_frames)
            kwargs.update(
                dynamo=True, optimize=(args.precision != "fp32"), report=True,
                artifacts_dir=str(args.output), fallback=False,
                dynamic_shapes=({1: frames}, {1: frames}, {1: frames},
                                {1: frames}, {1: frames}, {}),
            )
        else:
            kwargs.update(dynamo=False, do_constant_folding=False,
                dynamic_axes={name: {1: "frames"} for name in INPUT_NAMES[:-1] + OUTPUT_NAMES})
        with torch.inference_mode():
            torch.onnx.export(wrapper, example, str(output_path), **kwargs)
        import onnx
        onnx.checker.check_model(str(output_path))
        model = onnx.load(str(output_path), load_external_data=False)
        if args.precision == "bf16":
            # Conv-22 adds BF16 to the standard schema. The exported Conv
            # attributes and convolution semantics are otherwise unchanged.
            for opset in model.opset_import:
                if opset.domain == "":
                    opset.version = max(opset.version, 22)
        onnx.helper.set_model_props(model, {
            "precision": args.precision.upper(), "compute_precision": args.precision.upper(),
            "source_revision": result["source_revision"],
            "checkpoint_sha256": result["checkpoint_sha256"],
            "frontend_precision": "FP32", "euler_precision": "FP32",
        })
        onnx.save_model(model, str(output_path))
        onnx.checker.check_model(str(output_path), full_check=True)
        result["onnx"] = {
            "file": output_path.name, "ir_version": model.ir_version,
            "node_count": len(model.graph.node),
            "external_tensors": sum(bool(t.external_data) for t in model.graph.initializer),
            "opsets": {v.domain: v.version for v in model.opset_import},
        }
    result["elapsed_seconds"] = time.perf_counter() - started
    write_json(args.output / "model_contract.json", result)
    print(f"Done: {args.output}; {result['elapsed_seconds']:.1f}s", flush=True)


if __name__ == "__main__":
    main()
