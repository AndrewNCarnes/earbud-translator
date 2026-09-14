import { AutoProcessor, AutoTokenizer, Tensor, WhisperForConditionalGeneration, pipeline } from '@huggingface/transformers';

import type { FromWorker, Lang, ToWorker } from './messages';

const WHISPER_ID = 'onnx-community/whisper-base';
const TRANSLATION_IDS: Record<Lang, string> = {
  es: 'Xenova/opus-mt-es-en',
  en: 'Xenova/opus-mt-en-es',
};

// Whisper tends to invent these on silence or background noise.
const HALLUCINATIONS = new Set([
  'you',
  '...',
  'thank you.',
  'thanks for watching!',
  'thank you for watching.',
  'gracias.',
  'gracias por ver el video.',
  'subtítulos realizados por la comunidad de amara.org',
]);

// Narrow views of the Transformers.js objects, covering only what this worker calls.
type Processor = (audio: Float32Array) => Promise<{ input_features: Tensor }>;
type Tokenizer = { batch_decode(ids: Tensor, options: { skip_special_tokens: boolean }): string[] };
type Whisper = {
  generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  forward(inputs: Record<string, Tensor>): Promise<{ logits: Tensor }>;
  generate(options: Record<string, unknown>): Promise<Tensor>;
};
type Translate = (text: string) => Promise<{ translation_text: string }[]>;
type ProgressEvent = { status: string; name?: string; file?: string; loaded?: number; total?: number };

let processor: Processor;
let tokenizer: Tokenizer;
let whisper: Whisper;
let translators: Record<Lang, Translate>;
let queue: Promise<void> = Promise.resolve();

function post(message: FromWorker) {
  self.postMessage(message);
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    return !!(await gpu?.requestAdapter());
  } catch {
    return false;
  }
}

/** Sums byte progress across every model file into one overall figure. */
function trackProgress() {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info: ProgressEvent) => {
    if (info.status !== 'progress' || !info.file) {
      return;
    }
    files.set(`${info.name}/${info.file}`, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    post({ type: 'progress', loaded, total });
  };
}

async function load() {
  const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const progress_callback = trackProgress();

  const [loadedProcessor, loadedTokenizer, loadedWhisper, spanishToEnglish, englishToSpanish] = await Promise.all([
    AutoProcessor.from_pretrained(WHISPER_ID, { progress_callback }),
    AutoTokenizer.from_pretrained(WHISPER_ID, { progress_callback }),
    WhisperForConditionalGeneration.from_pretrained(WHISPER_ID, {
      device,
      // WebGPU mishandles q8 decoders, so it gets q4; WASM runs q8 fastest.
      dtype:
        device === 'webgpu'
          ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
          : { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback,
    }),
    // The translation models are small enough to run well on WASM.
    pipeline('translation', TRANSLATION_IDS.es, { device: 'wasm', dtype: 'q8', progress_callback }),
    pipeline('translation', TRANSLATION_IDS.en, { device: 'wasm', dtype: 'q8', progress_callback }),
  ]);

  processor = loadedProcessor as unknown as Processor;
  tokenizer = loadedTokenizer as unknown as Tokenizer;
  whisper = loadedWhisper as unknown as Whisper;
  translators = {
    es: spanishToEnglish as unknown as Translate,
    en: englishToSpanish as unknown as Translate,
  };

  // Run once on silence so WebGPU compiles its shaders now instead of on the first real phrase.
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
  if (!text || HALLUCINATIONS.has(text.toLowerCase())) {
    post({ type: 'skip', id });
    return;
  }
  const [{ translation_text }] = await translators[language](text);
  post({ type: 'result', id, language, confidence, text, translation: translation_text.trim() });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'load') {
    load().catch((error) => post({ type: 'error', message: `Couldn't load the models: ${errorMessage(error)}` }));
  } else {
    // One phrase at a time; the models can't run concurrently.
    queue = queue
      .then(() => handle(message.id, message.audio))
      .catch((error) => post({ type: 'error', id: message.id, message: errorMessage(error) }));
  }
});
