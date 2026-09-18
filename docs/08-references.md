# 08 — References

## Kernel

- Cordis (MIT, TypeScript meta-framework): https://github.com/cordiverse/cordis
- Explainer: https://dev.to/worldlinetech/understanding-cordis-the-typescript-framework-built-for-hot-swapping-everything-1ihb
- Cordis as the DeepSeek Harness plugin kernel: https://floatboat.ai/blog/cordis-plugin-framework
- Paper: Shi, Zhang, Cui, "A Programming Paradigm for Spatiotemporal Composability", arXiv:2608.25512
- Koishi (5 years of Cordis in production): https://koishi.chat

## Source separation

- Demucs / htdemucs_ft (Meta, MIT): https://github.com/facebookresearch/demucs
- Music-Source-Separation-Training (BS-RoFormer, Mel-Band RoFormer, MDX23C weights and inference): https://github.com/ZFTurbo/Music-Source-Separation-Training
- 2026 benchmark write-up: https://dev.to/codesugar_lin_037a57b06a4/htdemucs-vs-bs-roformer-vs-spleeter-a-2026-audio-source-separation-benchmark-2ll8
- Hugging Face collection of current models: https://huggingface.co/collections/StemSplitio/music-source-separation-toolkit-2026

## Transcription

- MuScriptor (Kyutai, Mirelo, IRCAM; CC BY 4.0; open weights; multi-instrument): https://arxiv.org/abs/2607.08168
- YourMT3+ (multi-instrument transformer): https://arxiv.org/abs/2407.04822
- 2025 AMT Challenge results: https://arxiv.org/abs/2603.27528
- Basic Pitch (Spotify, lightweight polyphonic, Apache-2.0, CPU-friendly, has a TensorFlow.js build): https://github.com/spotify/basic-pitch and https://basicpitch.io
- ByteDance piano transcription: https://github.com/bytedance/piano_transcription
- Onsets and Frames (Magenta): https://github.com/magenta/magenta/tree/main/magenta/models/onsets_frames_transcription
- Omnizart (piano, vocal, chord, drum, beat toolkit): https://github.com/Music-and-Culture-Technology-Lab/omnizart
- CREPE (monophonic pitch): https://github.com/marl/crepe
- Survey gist of audio-to-MIDI tools: https://gist.github.com/0xdevalias/f2c6e52824b3bbd4fb4c84c603a3f4bd

## Beat, key, and audio chord recognition

- ~~madmom (beats, downbeats, CNN chord recognition)~~: https://github.com/CPJKU/madmom
  — **does not install.** Last release 2018; its sdist needs a Cython and a
  setuptools from that era and there are no wheels for any Python we support.
  See ADR-009. `beat-tracker` uses librosa and Beat This!; `chord-audio` uses
  chroma and templates.
- Beat This! (beat tracker): https://github.com/CPJKU/beat_this
- Chordino / NNLS chroma (Vamp plugin): http://www.isophonics.net/nnls-chroma
- BTC, bi-directional transformer for chord recognition: https://github.com/jayg996/BTC-ISMIR19

## Symbolic music theory

- tonal.js (TypeScript): https://github.com/tonaljs/tonal
- music21 (Python, reference for Roman numeral analysis and chord naming): https://github.com/cuthbertLab/music21
- Krumhansl–Schmuckler key finding: standard reference profiles, implemented in both libraries above

## Notation and UI

- OpenSheetMusicDisplay (MusicXML in browser): https://github.com/opensheetmusicdisplay/opensheetmusicdisplay
- VexFlow: https://github.com/0xfe/vexflow
- Verovio (MEI/MusicXML engraving, C++ with JS build): https://github.com/rism-digital/verovio
- wavesurfer.js (waveform + regions): https://github.com/katspaugh/wavesurfer.js
- Web MIDI API: https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API
- Tauri (desktop wrapper, later): https://tauri.app

## Agent bridge

- Claude Agent SDK and headless `claude -p`: https://docs.claude.com/en/docs/claude-code
- OpenAI Codex CLI `codex exec`: https://github.com/openai/codex

## Log

- 2026-09-18: initial list.
