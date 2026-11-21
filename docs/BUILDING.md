# Build and developer workflow

[User installation](INSTALL.md) · [Contributing](../CONTRIBUTING.md) · [Licenses](LICENSING.md)

Running a release requires no Python. Building the C++ application also does not require Python. **Re-exporting model weights is a separate developer workflow that uses Python/PyTorch.**

## Source layout

| Path | Purpose |
| --- | --- |
| `native/` | Windows server/entry point, resident TTS engines, GPU helpers, audio editing, and RE-USE integration |
| `web/` | Plain HTML, CSS, and JavaScript interface; no npm build or CDN dependency |
| `third_party/headers/` | Pinned HTTP/JSON headers and notices |
| `presets/` | Public voice profiles, recordings, artwork, provenance, and licenses |
| `scripts/` | Verified dependency bootstrap, build, installation, and explicit update scripts |
| `tools/export/` | Developer model-conversion sources, where included; not runtime dependencies |
| `version.json` | Machine version and display version used by the public build |
| `licenses/` | Retained upstream/model/reference-code notices |

The public version starts at `0.1.0-beta.1`, displayed as **0.1 (beta)**. Earlier private development iteration numbers are not public release versions.

## Compile on Windows x64

Open PowerShell in the repository root:

```powershell
git clone https://github.com/sh-lee-prml/WaveGen-Studio.git
cd WaveGen-Studio
& .\scripts\bootstrap-build.ps1
& .\scripts\build.ps1
```

The bootstrap script verifies the SHA-256 of **LLVM-MinGW 20261104 UCRT x86_64** and Microsoft's **ONNX Runtime 1.31.1** Windows NuGet package. It extracts the C/C++ headers and x64 import library used by Studio. These files match the original CUDA 12 SDK byte for byte. The package's core DLL is used only to run the CPU storage tests. The release installer supplies the CUDA 12 runtime for inference. [Microsoft NuGet package](https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime.Gpu.Windows/1.31.1)

Build output is `build/app/WaveGen Studio.exe`, together with the web interface and public presets.

The build does not contain all runtime DLLs or exported model weights. Install the matching runtime/model packs before launching it. For a development replacement, copy the rebuilt EXE/web assets into a separate complete test installation while that application is closed; keep personal `data/` out of development and release staging.

Custom dependency locations are supported:

```powershell
& .\scripts\build.ps1 -ToolchainDirectory 'C:\dev\llvm-mingw' -OnnxRuntimeDirectory 'C:\dev\onnxruntime' -OutputDirectory 'C:\dev\wavegen-test'
```

Use the exact extracted toolchain/SDK root for each path. A compatible NVIDIA driver, Microsoft x64 Visual C++ Redistributable, and the matching runtime packs are still needed to run the result. The shipped native kernels compile through NVRTC; an installed CUDA Toolkit or `nvcc` is not required for this application build.

## Interface changes

Edit `web/` and build/copy into an isolated test installation. The local server serves these files directly. Preserve the four localization catalogs and parameter placeholders, user-written text, current playback, and editor buffers across language changes. Do not add an external CDN for core operation.

See [Contributing](../CONTRIBUTING.md) for review expectations. Exercise generation, cancellation/reconnection, voice metadata-only editing, immutable original-audio editing, transcript confirmation, and before/after enhancement when changing those paths. A frontend test does not replace native/GPU validation of an inference change.

## Models and native contracts

Flash and V-Spec are distinct exported graphs and checkpoint families. Flash uses four steps; V-Spec uses the official 50-step scheduled CFG policy, including its bottleneck-dropout behavior. The native interface checks model identity and required inputs. Use the model contracts and hashes from the exact release, including external weight files and frontend constants; do not interchange only the `.onnx` filenames.

RE-USE is an FP32 ONNX graph with a native CUDA selective-scan operator. The cached engine performs local preprocessing, overlap processing for long audio, and reconstruction. Its contract includes preservation of output sample rate/count and explicit handling of exact digital silence.

Native BF16 results are not bit-identical to upstream PyTorch. Test numerical intermediates, complete audio, deterministic behavior within the same setup, actual listening, and content—not only finite values or ASR accuracy—when changing an export or kernel.

## Re-exporting weights

The release model packs are the supported way to obtain the native graphs. See the [export workflow and pinned dependencies](../tools/export/README.md) for the developer commands. Conversion sources are developer material, not a one-click model training system. They need the pinned upstream source/checkpoints, build-time Python/PyTorch dependencies, substantial GPU memory, and the final precision/optimization passes. The original research implementation is in [WaveGen](https://github.com/sh-lee-prml/WaveGen); RE-USE is [published by NVIDIA](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE).

Before publishing a regenerated pack, document source revisions, checkpoint/export hashes, frontend constants, graph metadata, native parity and quality checks, and relevant licenses. Keep diagnostic fixtures and private user audio out of public assets. An export script finishing successfully does not by itself establish native parity or perceptual quality.

## Updating a release

Change `version.json`, rebuild, validate, and prepare release assets/manifests under the same version. Users update explicitly while the app is closed; preserve `data/`. See [Updating](UPDATING.md). Model/runtime changes must be reflected in their assets and checksums rather than silently replacing an existing download under the same identity.

For an app-only release, use a fresh output directory and the manifest downloaded from the previous official GitHub release. Compare the manifest SHA-256 against GitHub's release asset digest before packaging.

```powershell
python scripts/package-release.py --source-package build/app --app-dir build/app --output-dir release --packs app --reuse-components-from previous/manifest.json
```

Publish the new application ZIP, `manifest.json`, and `SHA256SUMS.txt`. The manifest retains the pinned archives, hashes, and download URLs of the existing runtime and models. The installer uses `model_pack_version` to locate their original entry in the verified Hugging Face configuration.
