# Install on Windows

[한국어](INSTALL_KO.md) · [README](../README.md) · [Update an installation](UPDATING.md)

## Requirements

- Windows x64 and an NVIDIA GPU with a compatible installed NVIDIA driver. The qualified configuration for this beta is **RTX 5080, 16 GB VRAM**; other GPUs and a lower VRAM minimum have not been established.
- A modern browser for the local interface and Windows PowerShell for the installer.
- The [Microsoft Visual C++ x64 Redistributable](https://aka.ms/vc14/vc_redist.x64.exe). Install it from Microsoft if it is missing; see [Microsoft's download guidance](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).
- Several GB of free space for the application, CUDA/cuDNN runtime, and model packs, plus space for download caches, backups, and your recordings.

**Python, Node.js, Visual Studio, and the CUDA Toolkit are not needed to run the release.** The necessary application runtime components are downloaded as release packs. The NVIDIA driver and Microsoft runtime are separate prerequisites.

WaveGen checkpoints are **CC BY-NC 4.0 (non-commercial)**. Read the [license map](LICENSING.md) before using the models.

## First installation

1. **[Download the Windows app ZIP](https://github.com/sh-lee-prml/WaveGen-Studio/releases/download/v0.1.0-beta.1/WaveGen-Studio-0.1.0-beta.1-app-windows-x64.zip)**, or find the app ZIP on this project's [Releases page](https://github.com/sh-lee-prml/WaveGen-Studio/releases). Extract it to a writable folder such as `C:\Apps\WaveGen Studio`. GitHub's **Source code** archives are for developers and are not needed to run the app.
2. Install the Microsoft runtime prerequisite above if it is missing, and ensure your NVIDIA driver is installed.
3. Double-click **Install-WaveGen-Studio.cmd** in the extracted folder. It installs into that same folder, finds the latest published release including betas, verifies release asset SHA-256 checksums, and downloads the runtime, Flash, V-Spec, and RE-USE packs. It does not launch the app automatically.
4. Double-click **Launch-WaveGen-Studio.cmd**. A local browser page opens. Choose a starter voice, type a short English sentence, and generate.

The full installation downloads about **3.9 GB**. Allow **15 GB of free space** for first-install download/extraction working room; later backups and recordings need more. The small app ZIP is only the starting point.

**Download sources:** the app and runtime are GitHub Release assets. The native Flash, V-Spec, and RE-USE model packs are delivered from the original [LeeSangHoon/WaveGen repository on Hugging Face](https://huggingface.co/LeeSangHoon/WaveGen). The release manifest pins an immutable Hugging Face revision and the hash of its `config.json`. When model downloads are needed, the installer obtains that configuration, verifies it, and uses its actual pack paths and checksums. Verified existing models and cached files are reused; there is no model download on every launch.

Choose a short installation path. The installer limits the resolved folder path to **128 characters** to leave room for Windows filenames; `C:\Apps\WaveGen Studio` is a suitable example.

If PowerShell blocks downloaded scripts, review the scripts and use your organization's approved script-running policy. Do not change a machine-wide policy just to use this application. A complete installation needs the app and its supporting folders, not only the EXE.

## Choose a folder or a smaller installation

For Flash only, open PowerShell in the extracted app folder and run:

```powershell
.\Install-WaveGen-Studio.cmd -Models flash
```

Advanced PowerShell installation can specify a destination directly:

```powershell
& .\scripts\install.ps1 -InstallDirectory 'C:\Apps\WaveGen Studio' -Models flash
```

When calling `scripts/install.ps1` directly without a destination, its default is `%LOCALAPPDATA%\WaveGen Studio`; the CMD wrapper instead uses its own folder. `-Models` accepts `flash`, `vspec`, and `reuse`; the default is all three. Omitting V-Spec or RE-USE means those features do not have their required model assets. You can install the remaining packs later using the same destination. Each TTS model occupies about 1.4 GB when extracted; the release manifest lists exact download sizes.

To let the script download and run Microsoft's signed official runtime installer when required, opt in explicitly:

```powershell
& .\scripts\install.ps1 -InstallVcRuntime
```

Microsoft's own installer may request system permissions. Studio does not bundle copied Microsoft runtime DLLs or install a GPU driver.

## Pin a release

Use the exact tag shown on the release page to avoid selecting a newer release:

```powershell
& .\scripts\install.ps1 -ReleaseTag 'v0.1.0-beta.1'
```

`manifest.json` lists the assets and their SHA-256 hashes. The installer checks downloaded bytes against that manifest. A checksum is an integrity check, not a digital signature or independent guarantee of the publisher's identity; obtain scripts and the manifest from the official repository/release.

Advanced/offline installation accepts `-ManifestPath` and `-CacheDirectory`. Prepopulate the cache with the exact assets listed in the selected manifest. A missing required asset still needs to be obtained; this option does not create a model from the source ZIP.

## If it does not start

| Symptom | Check |
| --- | --- |
| Missing `VCRUNTIME`/`MSVCP` DLL | Install Microsoft's current x64 Visual C++ Redistributable from the official link above |
| Missing ORT/CUDA/cuDNN DLL or provider error | Keep all runtime packs from the same release together; do not mix DLLs from other applications; check the NVIDIA driver |
| Model unavailable or missing file | Install the selected model pack into the same destination and retain its external weight files/constants |
| GPU memory error | Quit the app to release loaded models, close other GPU applications, and retry a shorter request with the needed model only; lower-VRAM hardware is not qualified |
| A download fails or hash does not match | Retry the installer using the same official release; do not bypass a failed hash check |

For a reproducible problem, use the [bug report form](https://github.com/sh-lee-prml/WaveGen-Studio/issues/new?template=bug_report.yml) with version, GPU/driver, selected model, and visible error. Do not attach your private `data/` folder.

For the original models, paper, training, and research implementation, please refer to [WaveGen](https://github.com/sh-lee-prml/WaveGen).
