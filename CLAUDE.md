# AirPod Translator

Website (installable PWA) meant for iPhone Safari with AirPods: hears English or Spanish, translates to the other language, and speaks it. Deployed to GitHub Pages at https://andrewncarnes.github.io/earbud-translator/ (repo `AndrewNCarnes/earbud-translator`, deploys on push to `main`).

## Engines (chosen in Settings; `src/main.ts`)
- `ai`: on-device AI via Transformers.js 4, in `src/worker.ts`.
  - Speech: `onnx-community/whisper-base` (WebGPU, or WASM q8 on phones).
  - Translation: `Xenova/opus-mt-*`.
  - Language detection is custom (`detectLanguage`: compares the `<|en|>`/`<|es|>` logits after one decoder step). Transformers.js has none, and multilingual Whisper silently defaults to English without it.
  - Known unfixed Transformers.js bug: crashes iPhone Safari while loading Whisper (issues #1241, #1242).
- `ai-legacy` (experimental): same pipeline on Transformers.js 2.15.1, installed as the npm alias `transformers-v2`, in `src/worker-legacy.ts`.
  - That library skips null `forced_decoder_ids` entries, so Whisper predicts the language token (position 1) itself.
  - The only reported workaround for the iOS crash, but unconfirmed.
- `webspeech`: browser speech recognition (`src/webspeech.ts`) plus MyMemory online translation (`src/online-translate.ts`). No download, needs internet, and the user picks the listening language.
  - iOS quirks handled: single-shot recognition restarted after each phrase, one reused instance, paused while speaking or when the page is hidden.
- `auto` (default): `webspeech` on iPhone, `ai` elsewhere. `?engine=<choice>` overrides it without saving (for testing).

## Shared pieces
- `src/audio.ts`: `@ricky0123/vad-web` (Silero VAD) splits mic audio into 16 kHz phrases for the AI engines.
- `src/speech.ts`: `speechSynthesis` output with voice ranking/picker. It must be unlocked during the Start tap on iOS.
- `src/messages.ts`: the worker message contract. Both workers speak it.
- `src/worker-shared.ts`: translation model IDs, hallucination filter, progress tracking.
- `public/sw.js` + `public/manifest.webmanifest`: offline app shell and home-screen install.

## Gotchas
- vad-web imports its own nested `onnxruntime-web`. `vite.config.ts` copies that copy's WASM, worklet and model into `dist/vad/`, and pre-bundles vad-web (it's CommonJS).
- ONNX Runtime's extended graph optimizations break the q8 Opus-MT and q8 Whisper-on-WASM models, so those load with `graphOptimizationLevel: 'basic'`.
- iPhone Safari kills tabs using ~1 GB+ ("A problem repeatedly occurred").
  - Models load one at a time, and iOS uses WASM + q8. Test that mode on a PC with `?lowmem`.
  - `LOAD_STAGE_KEY` detects a crash mid-load and skips auto-preload on the reload.
- `base: './'` in Vite so the site works under `/<repo>/` on GitHub Pages. The mic needs HTTPS (or localhost).
- The MyMemory email (`de` param) is only sent if the user enters one in Settings.

## Commands
- `npm run dev`: local dev server.
- `npm run build`: type-check + production build into `dist/`.
- Deploy: push to `main`; `.github/workflows/deploy.yml` builds and publishes to Pages.
