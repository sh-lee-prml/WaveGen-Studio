# Contributing

Thank you for helping improve WaveGen Studio. This beta needs clear bug reports, usability fixes, translations, reproducible native inference improvements, and voice samples with documented permission.

## Report a problem

Use the [bug report form](https://github.com/sh-lee-prml/WaveGen-Studio/issues/new?template=bug_report.yml). Include the public release version, Windows version, GPU and driver, selected model, steps to reproduce, and the visible error. If audio quality is involved, describe what you hear and provide a short example only when you can share it. Remove private paths and transcripts from logs. A whole `data/` folder is neither needed nor appropriate for a report.

Please distinguish an application failure from a model-quality limitation. An intelligible transcript alone does not show that audio sounds good; mention noise, pacing, speaker consistency, or edit boundaries separately.

## Contribute code or translations

1. Open an issue for a larger change so the scope can be agreed before implementation.
2. Follow [BUILDING.md](docs/BUILDING.md). Keep changes focused and describe the user-visible behavior.
3. Add a regression check for a corrected behavior when practical. State what you tested and on which hardware; do not generalize a single GPU benchmark.
4. Keep English, Korean, Simplified Chinese, and Japanese UI keys and placeholders consistent. Do not translate stored user text.
5. Preserve audio/history files, original reference audio, and cancellation/recovery behavior. Do not introduce automatic uploads or model downloads during normal synthesis.
6. Submit a pull request with the problem, change, validation, and any known limitations.

Original code contributions are submitted under this repository's MIT license. Contributions adapted from another project must identify the source, license, retained notices, and modifications. Model weights, recordings, and third-party components are **not** relicensed by a code contribution.

## Contribute a voice

Please read the [English guide](docs/VOICE_CONTRIBUTIONS.md) or [한국어 안내](docs/VOICE_CONTRIBUTIONS_KO.md), then use the [voice submission form](https://github.com/sh-lee-prml/WaveGen-Studio/issues/new?template=voice_submission.yml). We review the recording, exact transcript, quality, source, license, and permission before deciding whether it can be included. Please submit your own voice or a properly licensed source with the speaker's applicable permission. Do not present another person's voice as your identity or endorsement.

## Release changes

Public versioning starts at `0.1.0-beta.1`. Development snapshots and earlier local iteration numbers are not public release versions. See [BUILDING.md](docs/BUILDING.md) for the source layout and [UPDATING.md](docs/UPDATING.md) for the update contract. A change to model math, preprocessing, audio editing, or persistence requires relevant validation before a release.
