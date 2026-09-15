import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const VAD_DIST = 'node_modules/@ricky0123/vad-web/dist';
// ONNX Runtime 1.29 is shared by vad-web (deduped) and the natural-voice worker, which both load these WASM files at runtime.
const VAD_ORT_DIST = 'node_modules/onnxruntime-web/dist';

export default defineConfig({
  // Relative paths so the site works under a GitHub Pages sub-path (/<repo>/).
  base: './',
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
    // vad-web is CommonJS and `require`s onnxruntime-web. Pre-bundling converts that require;
    // excluding onnxruntime-web leaves a bare `require` that crashes the page on load in dev.
    include: ['@ricky0123/vad-web'],
  },
  plugins: [
    // The voice-activity detector loads its worklet, model, and ONNX runtime files at runtime from ./vad/.
    viteStaticCopy({
      targets: [
        { src: `${VAD_DIST}/vad.worklet.bundle.min.js`, dest: 'vad', rename: { stripBase: true } },
        { src: `${VAD_DIST}/silero_vad_v5.onnx`, dest: 'vad', rename: { stripBase: true } },
        { src: `${VAD_ORT_DIST}/ort-wasm-simd-threaded.{wasm,mjs}`, dest: 'vad', rename: { stripBase: true } },
      ],
    }),
  ],
});
