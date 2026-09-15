# Vendored code

- `piper-phonemize.js`: the Emscripten loader for piper-phonemize (espeak-ng compiled to WebAssembly). Copied from `@diffusionstudio/vits-web@1.0.3` (`dist/piper-DeOu3H9E.js`, MIT license).
  - That package only exports its high-level API.
  - Its `predict()` rebuilds the model session for every sentence, which is too slow on a phone, so `src/tts/tts-worker.ts` uses this module directly.
  - The `.wasm` and `.data` files it loads come from `@diffusionstudio/piper-wasm@1.0.0` on jsDelivr.
