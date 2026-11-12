# Using WaveGen Studio

[Install](INSTALL.md) · [한국어](USER_GUIDE_KO.md) · [Back to README](../README.md)

## Generate and listen

Choose a voice on the left, enter English text, and select **Generate** or press Ctrl+Enter. **Flash** is the four-step model; **V-Spec** is a separate checkpoint with 50 steps. Selecting a model does not start a generation. A model stays loaded after its first use until you quit the application.

The latest output is beside the composer on wide screens and immediately below Generate on narrower screens. Use **View audio** to jump to it when needed. Generation does not automatically play audio or move your focus. Download the WAV, open **Speech Edit**, or expand the result details. Generated files use 24 kHz mono audio.

Text and settings are saved in the browser. The selected interface language is also saved there, independently of the draft. Clearing site data removes these preferences; it does not remove the application's `data/` recordings.

## Length, speed, and seed

The length preview estimates the output audio, not processing time. Expand it to see the proposed text sections. Long-text splitting is enabled by default; text is divided at sentence or word boundaries and joined into one output. The current request limit is 5,000 UTF-8 bytes. Speech may vary at section boundaries.

Under **More settings**, set a seed, choose a new random seed, or enable a new seed for every generation. History stores the value actually used. Reusing an earlier result restores its seed and settings without generating immediately, with an undo option for your overwritten draft.

Automatic duration uses the text and reference. Target duration accepts 0.2–600 seconds for the new output, including section gaps; it disables speed control. This controls synthesis duration rather than stretching finished audio. Very short targets may be rejected; excessive targets can create unusual pauses. Start near the estimated duration.

## Reference audio

Choose **Add your voice** to register a new voice, or open an existing voice's settings. Use one speaker, a complete English sentence, and a clean 3–10 second reference. Use your own recording or one you have permission to use. Reference Text must match what is spoken, including the selected words after any cut.

1. Select or drop WAV/MP3 audio. The import limit is 50 MB and 120 seconds. The browser converts it to 24 kHz mono PCM WAV.
2. Open the reference editor. Drag the waveform or enter start/end times to keep a region. The saved reference must be **under 30 seconds**.
3. Preview the selected source and prepared version. Edge-silence trimming preserves pauses inside the retained speech. Optional peak adjustment aims for −3 dBFS with at most +12 dB gain; it can raise noise and affect later generated loudness.
4. Correct Reference Text to match the retained audio and confirm that it matches when requested. The application does not recognize or verify the words for you.
5. Add a name and optional image, then save. Merely opening an existing profile does not alter its audio.

Undo/redo and reset are available while editing. The source preserved for later edits is the decoded 24 kHz mono WAV, not the original MP3 bytes. A failed file replacement can be discarded while keeping the current recording. Unresolved enhancement previews must be applied or dismissed before saving. Unsaved edits prompt before closing the dialog or leaving the page.

Images are optional PNG/JPEG/WebP files up to 10 MB; the browser creates a centered 512×512 PNG. An image does not change the generated voice. Profile deletion moves it to trash and keeps its recordings available for restoration; it does not delete previously generated audio.

## Enhancement

Both enhancement features use the local NVIDIA RE-USE model and are off by default.

- **Prompt Enhancement:** process a prepared reference, listen before/after, and explicitly apply the result before saving the profile. It processes audio, not the written Reference Text.
- **Speech Enhancement:** process a finished generation or an older result. The original and enhanced recording are retained separately and can be compared. If enhancement fails after generation, the completed TTS original remains in history.

Enhancement can change timbre, breath, and other details. It is not guaranteed to improve a clean recording. Changing the reference range or processing invalidates an old enhancement preview; run it again for the new selection if needed.

## Speech Edit

Open a result's **Speech Edit** button. Select a region with the waveform, keyboard, or time fields. Listen to the selection, then keep it, remove it, or regenerate it using an English replacement sentence and a selected voice/model. Maintaining the selected duration keeps later audio at its original position; automatic replacement duration may move it.

Save to create a new recording. The original remains intact. Undo/redo is available in the open edit session. A short boundary fade is applied, but regenerated speech may not match surrounding prosody perfectly. The displayed full text remains the original transcript after an edit; it is marked accordingly and may no longer describe the whole recording.

## History, cancellation, and recovery

Search history by text or voice name and load earlier pages. Original and enhanced versions are grouped. Switching filters does not deliberately restart the active player. Loading text/settings does not start synthesis; if the original voice is unavailable, select an available voice before generating.

**Stop** asks an active operation to cancel at its supported processing boundary. Model preparation may need to finish first. Once saving begins, the completed result may be returned instead. Cancelled partial TTS output is not saved. For a temporary disconnection or page refresh, the application checks the request again; use the visible retry/status action if automatic recovery stops. Browser-storage restrictions can limit recovery across a reload.

## Storage and backup

Profiles, source/prepared audio, images, generated WAVs, metadata, trash, and profile revisions are stored in the installation's `data/` folder. The application does not upload these to a speech service. Initial installation and explicit updates download release assets.

Choose **Quit app**, then copy the whole `data/` folder for backup. Keep the complete application folder when moving an installation. Trash and past revisions are not automatically purged, so disk use grows over time. See [Updating and backup](UPDATING.md).
