# Native model conversion sources

These are optional **developer tools**. The Windows application runs without
Python. End users should obtain the verified release model packs through the
[installer](../../docs/INSTALL.md).

The wrappers and final graph passes are included so the native implementation
can be audited and changed. They use the original, pinned
[WaveGen](https://github.com/sh-lee-prml/WaveGen) and
[NVIDIA RE-USE](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE) definitions.
The full training code stays in those upstream projects. Model and source
licenses are separate; review [licensing](../../docs/LICENSING.md) first.

## Rebuild

Use Python 3.12 in a separate environment and a CUDA-capable GPU with substantial
free VRAM. Close other model applications before exporting. Intermediate FP32
and BF16 files need considerably more disk space than the final model packs.

```powershell
py -3.12 -m venv .venv-export
& .\.venv-export\Scripts\python.exe -m pip install torch==2.8.0+cu128 torchaudio==2.8.0+cu128 --index-url https://download.pytorch.org/whl/cu128
& .\.venv-export\Scripts\python.exe -m pip install -r tools/export/requirements.txt
& .\.venv-export\Scripts\python.exe tools/export/fetch_sources.py
& .\.venv-export\Scripts\python.exe tools/export/export_models.py --models flash vspec reuse
```

`fetch_sources.py` downloads only pinned source/configuration/checkpoint files,
checks hashes, and leaves existing changed files alone. The pinned WaveGen git
checkout includes upstream project files; no extra RE-USE example recordings
are fetched. The git checkout is under ignored `upstream/` and is not part of
Studio's source or binary release assets.
Set `WAVEGEN_REPOSITORY` to an existing matching WaveGen checkout, or
`REUSE_SOURCES` to a matching folder containing `official/` and `mamba_source/`,
when using sources managed elsewhere.

`--dry-run` prints the conversion sequence without loading GPU libraries.
`--models flash`, `--models vspec`, or `--models reuse` limits work.
`--work-directory` defaults to `build/export`; `--output-directory` defaults to
`build/exported-models`. Runtime output has Flash files at the root, V-Spec in
`vspec/`, and RE-USE in `reuse/`, matching the application's `model/` layout.
Optional `--fixtures` writes diagnostic tensors/audio to the work directory
using only the bundled licensed CMU Mira reference. Never package diagnostics
or private recordings into a public model release.

## What the passes do

- Flash: the released four-step tensor model, BF16 weight-cast compaction,
  static channel splits, and removal of zero-padding no-ops.
- V-Spec: the official 50-step scheduled CFG policy and explicit dropout masks;
  the same compaction, followed by FP32 dropout-scalar/activation opmath,
  fused biased BF16 linear layers, and ONNX 23 Attention with FP32 softmax.
  These passes repair premature rounding introduced by exporter decomposition.
- RE-USE: the original FP32 model with 120 custom selective-scan nodes, executed
  by the editable native CUDA implementation in `native/reuse_scan.h`.

The frontend policy files describe the BF16 mel calculation, including FP32
log output. Initial waveform RNG and native numerical kernels are not promised
to reproduce PyTorch audio bit-for-bit. An exporter completing successfully
does not establish native numerical parity or speech quality. Validate dynamic
lengths, scheduler boundaries, full audio, cancellation/reuse and silence on the
target GPU before distributing regenerated packs. The release packager removes
environment-specific graph metadata; it does not change weights or operators.
