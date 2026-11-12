# Update and back up

Updates are explicit. Studio does not silently replace its application, models, or runtime while you are working.

1. Choose **Quit app**. Closing only the browser tab is not enough.
2. Back up the installation's complete `data/` folder. It contains voices, recordings, originals, images, trash, and revisions. Browser draft/language preferences are separate browser storage.
3. Read the new release notes and use its update script. From the folder containing `scripts/`, run:

   ```powershell
   & .\scripts\update.ps1 -InstallDirectory 'C:\Apps\WaveGen Studio'
   ```

   Use your actual installation path. If omitted, a bundled updater infers its application root; a source-checkout updater defaults to `%LOCALAPPDATA%\WaveGen Studio`.
4. Wait for download, checksum validation, backup, and replacement to finish, then reopen **WaveGen Studio.exe**.

The updater requires the application to be closed, keeps `data/` and unmanaged files, and backs up replaced managed files under `backups/`. Keep a separate copy of `data/` as well. Do not merge your private data into a release archive or source contribution.

## Select the version and models

```powershell
& .\scripts\update.ps1 -InstallDirectory 'C:\Apps\WaveGen Studio' -ReleaseTag 'v0.1.0-beta.1' -Models flash,vspec,reuse
```

Without a tag the script selects the latest published release, including betas. The model default is all three; pass your desired selection explicitly when maintaining a smaller installation. The install script can also add missing model packs to an existing destination. `-ManifestPath` and `-CacheDirectory` support a local manifest/cache; `-InstallVcRuntime` explicitly opts into running Microsoft's official runtime installer if needed.

An older unmanaged installation without `.studio-install.json` cannot be updated in place by this script. Install the public release into a new folder, keep the old installation and its data backup, and migrate a copy of `data/` only after both apps are closed and the release's data compatibility is confirmed. Do not use the installer to overwrite an older private development folder.

App/runtime assets come from GitHub Releases; native model packs come from the original [LeeSangHoon/WaveGen Hugging Face repository](https://huggingface.co/LeeSangHoon/WaveGen). The release manifest pins the model repository revision and `config.json` hash. When model downloads are needed, that configuration is verified and used to resolve the actual packs. An app-only update reuses unchanged, verified model files instead of downloading them again; valid cached assets are also reused.

Runtime and model identities are pinned by the release manifest. Avoid mixing assets from different releases by manually replacing individual DLLs or weight files. Checksums detect changes relative to the manifest; they are not publisher signatures.

## If an update fails

Keep the error message and do not delete `data/` or the backup. Correct a download, disk-space, or prerequisite problem and retry the same release. For manual rollback, quit the app and restore a complete compatible application/runtime/model set with the corresponding backup; preserve a copy of the current `data/` first. A future data-format change may require its own migration notes, so downgrading is not universally guaranteed.

Report the release version, target version, and error through the [bug form](https://github.com/sh-lee-prml/WaveGen-Studio/issues/new?template=bug_report.yml), with private paths removed. See [Build and developer workflow](BUILDING.md) for preparing a tested source change.
