# AirPod Translator

Website meant for iPhone Safari with AirPods: listens for English or Spanish, translates to the other language, and speaks it. All AI runs in the browser (no server, no paid APIs). Deployed to GitHub Pages.

## Stack
- Vite + TypeScript, vanilla DOM (no framework).
- `src/worker.ts` (Web Worker, Transformers.js 4):
  - Speech: `onnx-community/whisper-base`, WebGPU when available, WASM otherwise.
  - Translation: `Xenova/opus-mt-es-en` and `Xenova/opus-mt-en-es`.
  - Language detection is custom (`detectLanguage`): one decoder step, comparing the `<|en|>` and `<|es|>` logits. Transformers.js has none built in, and multilingual Whisper silently defaults to English without it.
- `src/audio.ts`: `@ricky0123/vad-web` (Silero VAD) splits mic audio into 16 kHz phrases.
- `src/speech.ts`: `speechSynthesis` output. It must be unlocked during the Start tap on iOS.
- `src/main.ts`: UI, the speech queue, and the echo guard (phrases heard while speaking are dropped, not VAD pause, since pausing re-opens the mic on iOS).
- `src/messages.ts`: the worker message contract.

## Gotchas
- vad-web imports its own nested `onnxruntime-web` (differs from Transformers.js). `vite.config.ts` copies that copy's WASM plus the worklet and model into `dist/vad/`.
- `base: './'` in Vite so the site works under `/<repo>/` on GitHub Pages.
- The mic needs HTTPS (or localhost).
- iPhone Safari kills tabs that use much more than ~1 GB ("A problem repeatedly occurred"). Models load one at a time, and iOS uses WASM + q8 Whisper instead of WebGPU. Test that mode on a PC with `?lowmem`. `LOAD_STAGE_KEY` detects a crash mid-load and skips auto-preload on the reload.

## Commands
- `npm run dev`: local dev server (desktop Chrome/Safari works for testing).
- `npm run build`: type-check + production build into `dist/`.
- Deploy: push to GitHub; `.github/workflows/deploy.yml` builds and publishes to Pages.
