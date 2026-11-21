# Studio 0.2 starter voice check

The Windows application synthesized two English sentences with each new voice on Flash (4 steps) and V-Spec (50 steps). All eight transcriptions matched the requested words. Iris had a higher mean speaker similarity on these sentences than Cairn on both models.

Listen to the bundled reference recordings. [Cairn, 5.00 s](../presets/audio/cairn.wav) · [Iris, 5.15 s](../presets/audio/iris.wav)

| Starter voice | Model | Word errors / reference words | Corpus WER | Mean SIM |
| --- | --- | ---: | ---: | ---: |
| Cairn | Flash | 0 / 27 | 0% | 0.734 |
| Cairn | V-Spec | 0 / 27 | 0% | 0.723 |
| Iris | Flash | 0 / 27 | 0% | 0.787 |
| Iris | V-Spec | 0 / 27 | 0% | 0.797 |

**Reference selection.** We tested three complete recordings from each of three CMU ARCTIC speakers (AWB, CLB and JMK). Flash synthesized the same two screening sentences with each reference. We selected Cairn (AWB, Scottish English, `arctic_a0003`) and Iris (CLB, US English, `arctic_a0022`) based on intelligibility and similarity to their respective references. The official transcripts, recording URLs, preparation steps and hashes are in the [preset catalog](../presets/catalog.json). The original recording licenses are in [presets/licenses](../presets/licenses/).

**Held-out text.** The table uses two additional sentences, each distinct from the screening text and the reference transcripts.

1. “It was raining when we left the library, but the walk home was lovely.”
2. “Before you start recording, take a breath and read the first line aloud.”

**Settings and metrics.** Studio 0.2.0-beta.1 used seed 23, speed 1.0, automatic duration, and enhancement off. We evaluated the generated 24 kHz WAV files. Faster Whisper large-v3 transcribed each recording in English. We applied the WaveGen English text normalization and divided the total word edits by the total reference words in each row. SIM is the cosine similarity between the WavLM-Large / ECAPA speaker embeddings of the generated recording and its bundled reference. We averaged SIM over the two sentences for each row and truncated it to three decimal places for display. [WaveGen metric implementation](https://github.com/sh-lee-prml/WaveGen/blob/main/src/wavegen/eval/utils_eval.py)

This check covers two short English sentences at one seed per voice and model. It measures ASR intelligibility and embedding similarity. Per-record transcriptions, full-precision scores and audio hashes are in the [evaluation report](voice-evaluation.json).
