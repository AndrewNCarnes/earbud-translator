import { AutoProcessor, AutoTokenizer, Tensor, WhisperForConditionalGeneration, pipeline } from '@huggingface/transformers';

import type { Lang, ToWorker } from './messages';
import { TRANSLATION_IDS, errorMessage, isHallucination, post, trackProgress, type Translate } from './worker-shared';

const WHISPER_ID = 'onnx-community/whisper-base';
const TRANSLATION_OPTIONS = {
  device: 'wasm',
  dtype: 'q8',
  // ONNX Runtime's extended graph optimizations fail on these quantized Marian models
  // ("TransposeDQWeightsForMatMulNBits Missing required scale"), so stick to basic ones.
  session_options: { graphOptimizationLevel: 'basic' },
} as const;

// Narrow views of the Transformers.js objects, covering only what this worker calls.
type Processor = (audio: Float32Array) => Promise<{ input_features: Tensor }>;
type Tokenizer = { batch_decode(ids: Tensor, options: { skip_special_tokens: boolean }): string[] };
type Whisper = {
  generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  forward(inputs: Record<string, Tensor>): Promise<{ logits: Tensor }>;
  generate(options: Record<string, unknown>): Promise<Tensor>;
};

let processor: Processor;
let tokenizer: Tokenizer;
let whisper: Whisper;
let translators: Record<Lang, Translate>;
let queue: Promise<void> = Promise.resolve();

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    return !!(await gpu?.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * Loads models one at a time: each file is buffered and copied while it loads, so loading
 * everything in parallel spikes memory past what iPhone Safari allows before it kills the tab.
 */
async function load(lowMemory: boolean) {
  // WebGPU keeps extra copies of the weights and needs the larger fp32/q4 variants, so phones use WASM with q8.
  const device = !lowMemory && (await hasWebGPU()) ? 'webgpu' : 'wasm';

  post({ type: 'stage', label: 'speech model' });
  const whisperProgress = trackProgress();
  processor = (await AutoProcessor.from_pretrained(WHISPER_ID, { progress_callback: whisperProgress })) as unknown as Processor;
  tokenizer = (await AutoTokenizer.from_pretrained(WHISPER_ID, { progress_callback: whisperProgress })) as unknown as Tokenizer;
  whisper = (await WhisperForConditionalGeneration.from_pretrained(WHISPER_ID, {
    device,
    // WebGPU mishandles q8 decoders, so it gets q4; WASM runs q8 fastest and smallest.
    dtype:
      device === 'webgpu'
        ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
        : { encoder_model: 'q8', decoder_model_merged: 'q8' },
    // Same ONNX Runtime QDQ optimizer bug as the translation models hits the q8 decoder on WASM.
    ...(device === 'wasm' ? { session_options: { graphOptimizationLevel: 'basic' as const } } : {}),
    progress_callback: whisperProgress,
  })) as unknown as Whisper;

  // The translation models are small enough to run well on WASM.
  post({ type: 'stage', label: 'Spanish → English model' });
  const spanishToEnglish = (await pipeline('translation', TRANSLATION_IDS.es, {
    ...TRANSLATION_OPTIONS,
    progress_callback: trackProgress(),
  })) as unknown as Translate;

  post({ type: 'stage', label: 'English → Spanish model' });
  const englishToSpanish = (await pipeline('translation', TRANSLATION_IDS.en, {
    ...TRANSLATION_OPTIONS,
    progress_callback: trackProgress(),
  })) as unknown as Translate;

  translators = { es: spanishToEnglish, en: englishToSpanish };

  // Run once on silence so the first real phrase doesn't pay one-time setup costs (e.g. WebGPU shader compiles).
  post({ type: 'stage', label: 'warm-up' });
  await transcribe(new Float32Array(16_000));

  post({ type: 'ready', device });
}

/**
 * Transformers.js has no Whisper language detection (multilingual models silently default to English),
 * so run one decoder step after <|startoftranscript|> and compare the <|en|> and <|es|> logits.
 */
async function detectLanguage(input_features: Tensor): Promise<{ language: Lang; confidence: number }> {
  const { decoder_start_token_id, lang_to_id } = whisper.generation_config;
  const decoder_input_ids = new Tensor('int64', BigInt64Array.from([BigInt(decoder_start_token_id)]), [1, 1]);
  const { logits } = await whisper.forward({ input_features, decoder_input_ids });

  const scores = logits.data as Float32Array;
  const english = scores[lang_to_id['<|en|>']];
  const spanish = scores[lang_to_id['<|es|>']];
  const spanishProbability = 1 / (1 + Math.exp(english - spanish));

  return spanishProbability >= 0.5
    ? { language: 'es', confidence: spanishProbability }
    : { language: 'en', confidence: 1 - spanishProbability };
}

async function transcribe(audio: Float32Array) {
  const { input_features } = await processor(audio);
  const detected = await detectLanguage(input_features);
  const ids = await whisper.generate({
    inputs: input_features,
    language: detected.language,
    task: 'transcribe',
    max_new_tokens: 128,
  });
  const text = tokenizer.batch_decode(ids, { skip_special_tokens: true })[0]?.trim() ?? '';
  return { ...detected, text };
}

async function handle(id: number, audio: Float32Array) {
  const { language, confidence, text } = await transcribe(audio);
  if (isHallucination(text)) {
    post({ type: 'skip', id });
    return;
  }
  const [{ translation_text }] = await translators[language](text);
  post({ type: 'result', id, language, confidence, text, translation: translation_text.trim() });
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'load') {
    load(message.lowMemory).catch((error) =>
      post({ type: 'error', message: `Couldn't load the models: ${errorMessage(error)}` }),
    );
  } else {
    // One phrase at a time; the models can't run concurrently.
    queue = queue
      .then(() => handle(message.id, message.audio))
      .catch((error) => post({ type: 'error', id: message.id, message: errorMessage(error) }));
  }
});
