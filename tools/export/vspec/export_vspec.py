"""Build-time export of the released WaveGen VSpec 50-step BF16 sampler.

The resulting runtime graph requires no Python. Explicit CUDA dropout masks
keep RNG policy separate from network mathematics and permit exact fixtures.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
REPO = Path(os.environ.get("WAVEGEN_REPOSITORY", ROOT / "upstream/WaveGen")).resolve()
sys.path.insert(0, str(REPO / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import numpy as np
import torch
from torch import nn

INPUT_NAMES = ("wav_state", "mel_state", "wav_cond", "mel_cond", "text_ids", "time",
               "prompt_frames", "step_index", "bottleneck_keep")
OUTPUT_NAMES = ("wav_velocity", "mel_velocity")
CKPT = REPO / "ckpts/WaveGen_VSpec/model_1400000.safetensors"

def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

def dump_tensor(directory, name, tensor):
    value = tensor.detach().cpu().contiguous().numpy() if torch.is_tensor(tensor) else np.asarray(tensor)
    kind = "<i8" if value.dtype == np.int64 else "<f4"
    path = directory / (name + (".i64" if kind == "<i8" else ".f32"))
    value.astype(kind, copy=False).tofile(path)
    return dict(file=path.name, shape=list(value.shape), dtype=kind, bytes=path.stat().st_size, sha256=sha256(path))

def errors(expected, actual):
    delta = (expected.float() - actual.float()).double()
    return dict(max_absolute=float(delta.abs().max()), mean_absolute=float(delta.abs().mean()),
                rms=float(delta.square().mean().sqrt()), unequal_count=int(torch.count_nonzero(delta)))

class VSpecStep(nn.Module):
    """One packed cond/null evaluation; FP32 states, BF16 heads and dropout.

Host anchors the prompt before calling and overrides prompt velocities after.
Dropout mask order: cond first/second, null first/second, all binary FP32.
"""
    def __init__(self, transformer):
        super().__init__()
        self.net = transformer

    def embed(self, wav, mel, cond, mel_cond, text, first_keep, second_keep):
        embed = self.net.input_embed
        h = embed.mel_proj(mel)
        h = h * first_keep.to(h.dtype) / 0.8
        h = embed.mel_bottleneck.linear2(h)
        h = h * second_keep.to(h.dtype) / 0.8
        wav_h, cond_h = embed.x_proj(wav), embed.cond_proj(cond)
        h = embed.fuse(torch.cat((wav_h, cond_h, h, mel_cond, text), dim=-1))
        return embed.conv_pos_embed(h, mask=None) + h

    def forward(self, wav_state, mel_state, wav_cond, mel_cond, text_ids, time,
                prompt_frames, step_index, bottleneck_keep):
        net = self.net
        frames = wav_state.shape[1]
        with torch.autocast("cuda", dtype=torch.bfloat16):
            t = net.time_embed(time)
            text_cond = net.text_embed(text_ids, frames, drop_text=False)
            text_null = net.text_embed(text_ids, frames, drop_text=True)
            joint_null = step_index.reshape(1, 1, 1) >= 3
            prompt = torch.arange(frames, device=wav_state.device).reshape(1, frames, 1) < prompt_frames.reshape(1, 1, 1)
            null_wav = torch.where(joint_null & prompt, 0.0, wav_state)
            null_mel = torch.where(joint_null & prompt, 0.0, mel_state)
            null_cond = torch.where(joint_null, 0.0, wav_cond)
            null_mel_cond = torch.where(joint_null, 0.0, mel_cond)
            cond = self.embed(wav_state, mel_state, wav_cond, mel_cond, text_cond, bottleneck_keep[0], bottleneck_keep[1])
            null = self.embed(null_wav, null_mel, null_cond, null_mel_cond, text_null, bottleneck_keep[2], bottleneck_keep[3])
            value = torch.cat((cond, null), dim=0)
            t = torch.cat((t, t), dim=0)
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
        result = []
        for predictions, state in ((pred_wav, wav_state), (pred_mel, mel_state)):
            cond, null = predictions[:1], predictions[1:]
            proxy = (cond.float() - 2.0 * (cond.float() - null.float())).to(cond.dtype)
            null = torch.where(time.reshape(1, 1, 1) < 0.5, proxy, null)
            denom = (1.0 - time).clamp_min(0.02).reshape(1, 1, 1)
            vc, vu = (cond.float() - state) / denom, (null.float() - state) / denom
            result.append(vc + (vc - vu) * 1.25)
        # Official default skips the unused last Mel head; its velocity is zero.
        result[1] = torch.where(step_index.reshape(1, 1, 1) == 49, 0.0, result[1])
        return tuple(result)

def load_engine(device):
    from wavegen_v_spec.infer.utils_infer import WaveGen
    return WaveGen.from_checkpoint(CKPT, CKPT.parent / "vocab.txt", config=CKPT.parent / "WaveGen_VSpec.yaml",
                                   device=device, dtype="bf16")

def example_inputs(frames, device, step=0, value=0.25):
    generator = torch.Generator(device=device).manual_seed(123)
    return (
        torch.randn((1, frames, 480), generator=generator, device=device),
        torch.randn((1, frames, 80), generator=generator, device=device),
        torch.randn((1, frames, 480), generator=generator, device=device),
        torch.randn((1, frames, 80), generator=generator, device=device),
        torch.arange(frames, device=device, dtype=torch.int64).remainder(100).reshape(1, frames),
        torch.tensor([value], device=device), torch.tensor([frames // 2], device=device),
        torch.tensor([step], device=device),
        torch.rand((4, 1, frames, 32), device=device, generator=generator).ge(0.2).float(),
    )

def official_velocity(model, prediction, wav, mel, time_value, step):
    values = []
    for pred, state in zip(prediction, (wav, mel)):
        if pred is None:
            values.append(torch.zeros_like(state))
            continue
        cond, null = pred.chunk(2, dim=0)
        if float(time_value.item()) < 0.5:
            null = (cond.float() - 2 * (cond.float() - null.float())).to(cond.dtype)
        vc, vu = model._x_to_v(cond.reshape_as(state), state, time_value), model._x_to_v(null.reshape_as(state), state, time_value)
        values.append(vc + (vc - vu) * 1.25)
    return tuple(values)

def compare_wrapper(engine, wrapper, directory):
    """Feed identical masks to the official transformer and exported wrapper."""
    bottleneck = engine.model.transformer.input_embed.mel_bottleneck
    original = bottleneck._inverted_dropout
    records = []
    try:
        for frames, step, time_value in ((16, 0, 0.0), (24, 2, 0.0005), (32, 3, 0.001), (18, 44, 0.55), (20, 49, 0.89)):
            args = example_inputs(frames, engine.device, step, time_value)
            wav, mel, cond, mel_cond, ids, t, pf, si, keeps = args
            counter = [0]
            def supplied(value, probability, generator):
                mask = keeps[counter[0]]
                counter[0] += 1
                return value * mask.to(value.dtype) / (1.0 - probability)
            bottleneck._inverted_dropout = supplied
            prompt = torch.arange(frames, device=engine.device).reshape(1, frames, 1).expand_as(wav) < pf.reshape(1, 1, 1)
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                prediction, _, _ = engine.model.transformer(
                    x=wav.flatten(1), cond=cond.flatten(1), mel=mel, mel_cond=mel_cond, text=ids, time=t,
                    cfg_infer=True, cfg_null_audio=step >= 3, prompt_mask=prompt.flatten(1), cache=False,
                    inference_bottleneck_dropout=0.2, predict_mel=step != 49)
                want = official_velocity(engine.model, prediction, wav, mel, t, step)
                actual = wrapper(*args)
            record = dict(frames=frames, step=step, time=time_value, errors={})
            for name, expected, got in zip(OUTPUT_NAMES, want, actual):
                record["errors"][name] = errors(expected, got)
                torch.testing.assert_close(got, expected, rtol=0, atol=0)
            case = directory / f"step_f{frames}_k{step}"
            case.mkdir(exist_ok=True)
            record["inputs"] = {name: dump_tensor(case, name, item) for name, item in zip(INPUT_NAMES, args)}
            record["outputs"] = {name: dump_tensor(case, name, item) for name, item in zip(OUTPUT_NAMES, want)}
            write_json(case / "case.json", record)
            records.append(record)
            print("Exact wrapper parity", frames, step, flush=True)
    finally:
        bottleneck._inverted_dropout = original
        engine.model.transformer.clear_cache()
    return records

def export_frontend(engine, directory):
    frontend = engine.model.mel_f.mel_stft
    assets = {"mel_filter": dump_tensor(directory, "mel_filter", frontend.mel_scale.fb),
              "hann_window": dump_tensor(directory, "hann_window", frontend.spectrogram.window)}
    grid = torch.linspace(0, 1, 51, device=engine.device, dtype=torch.float32).pow(2.0)
    grid = grid / (grid + 3.0 * (1 - grid))
    assets["timesteps"] = dump_tensor(directory, "timesteps", grid)
    shutil.copyfile(CKPT.parent / "vocab.txt", directory / "vocab.txt")
    for name in ("frontend_precision.txt", "frontend_precision.json"):
        shutil.copyfile(HERE.parent / name, directory / name)
    return assets

def make_fixture(engine, wrapper, directory):
    """Record original PyTorch sampler state, masks and generated waveform."""
    from wavegen_v_spec.infer.utils_infer import _prepare_prompt
    from wavegen_v_spec.model.utils import convert_char_to_pinyin
    ref = ROOT / "presets/audio/mira.wav"
    ref_text = "I'm playing a single hand in what looks like a losing game."
    text = "Here we generate something just for test."
    prompt, rms, prompt_samples, predicted_samples, combined = _prepare_prompt(ref, ref_text, text, sample_rate=24000, frame_length=480, speed=1.0)
    folder = directory / "fixture"
    folder.mkdir(exist_ok=True)
    net = engine.model.transformer
    bottleneck = net.input_embed.mel_bottleneck
    original_drop, original_forward = bottleneck._inverted_dropout, net.forward
    all_masks, selected, first_args = [], {}, []
    active_masks = []
    def record_dropout(value, probability, generator):
        keep = torch.rand(value.shape, device=value.device, dtype=torch.float32, generator=generator).ge(probability)
        active_masks.append(keep.float())
        return value * keep.to(value.dtype) / (1.0 - probability)
    def record_forward(*args, **kwargs):
        step = len(all_masks)
        active_masks.clear()
        answer = original_forward(*args, **kwargs)
        keeps = torch.stack(active_masks)
        all_masks.append(keeps.cpu())
        frames = kwargs["x"].shape[1] // 480
        ids = kwargs["text"][:, :frames]
        ids = torch.nn.functional.pad(ids, (0, max(0, frames - ids.shape[1])), value=-1)
        graph_args = (kwargs["x"].reshape(1, frames, 480), kwargs["mel"], kwargs["cond"].reshape(1, frames, 480),
                      kwargs["mel_cond"], ids, kwargs["time"].reshape(1),
                      torch.tensor([prompt_samples // 480], device=engine.device),
                      torch.tensor([step], device=engine.device), keeps)
        if step == 0:
            first_args.extend(value.detach().clone() for value in graph_args)
        if step in (0, 2, 3, 43, 49):
            case = folder / f"step{step}"
            case.mkdir(exist_ok=True)
            expected = official_velocity(engine.model, answer[0], graph_args[0], graph_args[1], graph_args[5], step)
            got = wrapper(*graph_args)
            for actual, want in zip(got, expected):
                torch.testing.assert_close(actual, want, rtol=0, atol=0)
            selected[str(step)] = {
                "inputs": {name: dump_tensor(case, name, item) for name, item in zip(INPUT_NAMES, graph_args)},
                "outputs": {name: dump_tensor(case, name, item) for name, item in zip(OUTPUT_NAMES, expected)},
                "parity": {name: errors(want, actual) for name, want, actual in zip(OUTPUT_NAMES, expected, got)}}
        print(f"Official sampler {step + 1}/50", flush=True) if step % 10 == 0 else None
        return answer
    try:
        bottleneck._inverted_dropout, net.forward = record_dropout, record_forward
        torch.cuda.manual_seed(0)
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            generated, trajectory = engine.model.sample(
                cond=prompt.to(engine.device), text=convert_char_to_pinyin([combined]), duration=predicted_samples,
                steps=50, cfg_strength=1.25, cfg_schedule="scheduled_k3", inference_method="Prompt_xt_Anchor",
                timestep_mapping="power", timestep_power=2.0, shift=3.0, use_epss=False, seed=None,
                mel_temperature=0.0, inference_bottleneck_dropout=0.2, inference_bottleneck_dropout_seed=0,
                max_duration=1500, compute_final_mel=False)
    finally:
        bottleneck._inverted_dropout, net.forward = original_drop, original_forward
        net.clear_cache()
    frames = first_args[0].shape[1]
    wave = generated[0, prompt_samples:predicted_samples]
    if rms < 0.1:
        wave = wave * rms / 0.1
    import soundfile as sf
    sf.write(folder / "official.wav", wave.float().cpu().numpy(), 24000, subtype="PCM_16")
    assets = {name: dump_tensor(folder, name if name != "bottleneck_keep" else "bottleneck_keep_step0", value)
              for name, value in zip(INPUT_NAMES, first_args)}
    assets["all_bottleneck_keep"] = dump_tensor(folder, "bottleneck_keep", torch.stack(all_masks))
    assets["initial_wav"] = dump_tensor(folder, "initial_wav", first_args[0])
    assets["generated_waveform"] = dump_tensor(folder, "generated_waveform", wave)
    assets["generated_full"] = dump_tensor(folder, "final_full", generated)
    # sample() returns a tuple containing the complete wave and Mel trajectories.
    if isinstance(trajectory, tuple):
        for name, value in zip(("trajectory_wav", "trajectory_mel"), trajectory):
            assets[name] = dump_tensor(folder, name, value)
    else:
        assets["trajectory_wav"] = dump_tensor(folder, "trajectory_wav", trajectory)
    info = dict(frames=frames, prompt_frames=prompt_samples // 480, prompt_samples=prompt_samples,
                predicted_samples=predicted_samples, source_reference=str(ref), reference_text=ref_text,
                generation_text=text, reference_rms=float(rms), seed=0, steps=50, assets=assets, selected_steps=selected)
    write_json(folder / "fixture.json", info)
    return info

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, default=HERE / "artifacts_bf16")
    p.add_argument("--device", default="cuda")
    p.add_argument("--frames", type=int, default=16)
    p.add_argument("--max-frames", type=int, default=1500)
    p.add_argument("--fixtures", action="store_true")
    p.add_argument("--skip-export", action="store_true")
    p.add_argument("--skip-wrapper-check", action="store_true")
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    torch.set_num_threads(4)
    engine = load_engine(args.device)
    wrapper = VSpecStep(engine.model.transformer).eval()
    info = dict(model="WaveGen_VSpec", started_at_utc=datetime.now(timezone.utc).isoformat(),
                source_revision="399ce751225001da75a62725f8827693a51bcc18", torch_version=torch.__version__,
                checkpoint_sha256=sha256(CKPT), checkpoint_file=CKPT.name,
                precision="FP32 source weights; CUDA BF16 autocast; FP32 states and guided velocities",
                frontend_precision="BF16", sample_rate=24000, frame_samples=480, mel_channels=80, batch_size=1,
                max_frames=args.max_frames, steps=50, ort_runs=50, model_evaluations=100, cfg_strength=1.25, cfg_schedule="scheduled_k3",
                inference_method="Prompt_xt_Anchor", timestep_mapping="power", timestep_power=2.0, shift=3.0,
                inference_bottleneck_dropout=0.2, inference_bottleneck_dropout_seed=0, mel_temperature=0.0,
                latents_scale=9.0, t_eps=0.02, input_names=list(INPUT_NAMES), output_names=list(OUTPUT_NAMES),
                input_shapes={"wav_state":[1,"F",480], "mel_state":[1,"F",80], "wav_cond":[1,"F",480],
                              "mel_cond":[1,"F",80], "text_ids":[1,"F"], "time":[1], "prompt_frames":[1],
                              "step_index":[1], "bottleneck_keep":[4,1,"F",32]},
                input_int64=["text_ids","prompt_frames","step_index"], other_inputs="float32",
                mask_order=["cond_dropout1","cond_dropout2","null_dropout1","null_dropout2"],
                mask_rng="four separate torch.rand([1,F,32], CUDA generator seeded0).ge(.2) per step; independent of wave seed",
                host_contract="Anchor input prompt with (1-t)*initial+t*clean; override output prompt velocities clean-initial; Euler original state+=dt*velocity. Final wave /9, trim prompt and restore low RMS.",
                final_mel="Graph evaluates final Mel head but sets its velocity zero at step49, equivalent to official compute_final_mel=False output")
    info["frontend_assets"] = export_frontend(engine, args.output)
    if not args.skip_wrapper_check:
        info["wrapper_parity"] = compare_wrapper(engine, wrapper, args.output)
    if args.fixtures:
        info["fixture_frames"] = make_fixture(engine, wrapper, args.output)["frames"]
    if not args.skip_export:
        print("Exporting dynamic BF16 graph...", flush=True)
        from torch.export import Dim
        f = Dim("frames", min=2, max=args.max_frames)
        path = args.output / "wavegen_vspec_step.onnx"
        with torch.inference_mode():
            torch.onnx.export(wrapper, example_inputs(args.frames, args.device), str(path),
                              input_names=list(INPUT_NAMES), output_names=list(OUTPUT_NAMES), opset_version=18,
                              external_data=True, dynamo=True, optimize=True, report=True, fallback=False,
                              artifacts_dir=str(args.output),
                              dynamic_shapes=({1:f},{1:f},{1:f},{1:f},{1:f},{},{},{},{2:f}))
        import onnx
        model = onnx.load(str(path), load_external_data=False)
        for opset in model.opset_import:
            if opset.domain == "":
                opset.version = max(22, opset.version)
        onnx.helper.set_model_props(model, {"model":"WaveGen_VSpec", "model_id":"vspec", "steps":"50", "precision":"BF16", "compute_precision":"BF16", "frontend_precision":"BF16",
            "cfg_schedule":"scheduled_k3", "cfg_strength":"1.25", "inference_bottleneck_dropout":"0.2", "mel_temperature":"0.0",
            "sampler":"euler", "timestep_mapping":"power2_shift3", "checkpoint_sha256":info["checkpoint_sha256"]})
        onnx.save_model(model, str(path))
        onnx.checker.check_model(str(path), full_check=True)
        info["onnx"] = dict(file=path.name, node_count=len(model.graph.node), ir_version=model.ir_version,
                            opsets={v.domain:v.version for v in model.opset_import})
    info["elapsed_seconds"] = time.perf_counter() - started
    write_json(args.output / "model_contract.json", info)
    print("Completed", args.output, info["elapsed_seconds"], flush=True)

if __name__ == "__main__":
    main()
