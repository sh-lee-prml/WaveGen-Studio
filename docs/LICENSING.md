# Licenses by component

The license of the application code is separate from the licenses of models, recordings, and runtime libraries. **WaveGen checkpoints are non-commercial under CC BY-NC 4.0.** A permissive reference recording or an MIT-licensed interface does not remove that model condition.

| Component | Terms and retained notice |
| --- | --- |
| Original Studio C++, web interface, scripts, and documentation | [MIT](../LICENSE), Copyright 2026 WaveGen Studio contributors; third-party portions remain under their own notices |
| WaveGen source contributions | [Upstream MIT](../licenses/WaveGen/LICENSE), Copyright 2026 Sang-Hoon Lee; see the [retained upstream third-party inventory](../licenses/WaveGen/THIRD_PARTY_NOTICES.md) |
| WaveGen Flash / V-Spec checkpoints and converted inference weights | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), with [model notice](../licenses/WaveGen/MODEL_LICENSE.txt); ONNX/BF16 conversion is a modification, not a new license |
| NVIDIA NemotronLabs RE-USE model and supplied related materials | [OpenMDW-1.1](../licenses/REUSE-OpenMDW-1.1.txt), Copyright 2026 NVIDIA CORPORATION & AFFILIATES |
| Mamba reference implementation | [Apache-2.0](../licenses/Mamba-Apache-2.0.txt); copyright and origins retained |
| cpp-httplib and nlohmann/json | MIT, with upstream notices in `third_party/headers/` |
| ONNX Runtime | MIT and its included third-party notices, supplied with the runtime SDK/pack |
| Statically linked LLVM-MinGW runtime portions | Applicable LLVM/MinGW notices in `licenses/toolchain/`, retained with the application binary |
| NVIDIA CUDA, NVRTC, and cuDNN runtime components | NVIDIA's applicable license/EULA and redistributable terms, included with the corresponding runtime packs; not MIT |
| Microsoft Visual C++ runtime | Install the official Microsoft x64 Redistributable separately; Studio does not grant or replace its license |
| Mira / Rowan / Kai reference recordings | Original CMU ARCTIC conditions in `presets/licenses/`; retain copyright, conditions, disclaimer, author names, and modification notices |
| Three starter portraits | [Dedicated fictional-artwork notice](ARTWORK.md); not images of the recording speakers |
| Submitted or locally added voices/images | Their own stated permissions and licenses; not automatically MIT |

## Model origins and modifications

The original project is [WaveGen](https://github.com/sh-lee-prml/WaveGen) by Sang-Hoon Lee and Ha-Yeong Choi. The [official license section](https://github.com/sh-lee-prml/WaveGen#license) separates source licensing from checkpoint licensing. Flash uses four steps; V-Spec uses a separate 50-step checkpoint. Studio converts inference to ONNX, uses BF16 weights with selected FP32 operations, and provides native C++ preprocessing and sampling. No training or fine-tuning is represented by this package.

[NVIDIA RE-USE](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE) is converted to FP32 ONNX with a native Windows CUDA selective-scan operation and native audio preprocessing/chunking. Its [official license](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE/blob/31f82f2efad1095034492f236e8dac9239ba713b/LICENSE) covers its supplied model materials. Mamba's [official Apache-2.0 license](https://github.com/state-spaces/mamba/blob/main/LICENSE) remains applicable to its reference code. Exact model revisions and hashes belong to the release manifests/contracts.

## Upstream scope

This repository does not claim an MIT-only license for the whole upstream research tree. The retained WaveGen inventory documents Apache-2.0 portions, the separate optional ECAPA evaluator's CC BY-SA terms, and unresolved intermediate-source provenance. Studio does not vendor that evaluator or the complete research tree as original Studio code. If reproducing model export, review the upstream tree's own notices; this repository does not resolve or override them.

## Reference recordings

Mira, Rowan, and Kai are fictional display aliases for the SLT, BDL, and RMS CMU ARCTIC sources, respectively, using utterance `arctic_a0010`. Source: [CMU ARCTIC](http://festvox.org/cmu_arctic/), John Kominek and Alan W Black, *CMU ARCTIC databases for speech synthesis*, CMU-LTI-03-177. SLT and BDL carry Carnegie Mellon University copyright 2003; RMS carries 2004.

The supplied full utterances were converted from 16 kHz mono PCM16 to 24 kHz mono PCM16 using polyphase resampling (`up=3`, `down=2`). No trimming, denoising, gain adjustment, new words, or added silence was applied. The recordings are not CC0 or public domain. Their original notices allow broad use subject to the retained conditions; this is not a claim of speaker endorsement or unlimited identity/personality rights. See the supplied `presets/licenses/` and preset source metadata.

## Redistribution

Keep the applicable notices with the components you distribute. Do not relabel model weights, DLLs, recordings, or third-party code as Studio MIT. Application updates and archives must exclude private `data/`, user recordings, and local history. Microsoft runtime installation should use the [official download guidance](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist), not copied DLLs from another application.
