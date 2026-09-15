// Experimental: the same pipeline on Transformers.js 2.15.1, the only reported workaround for
// Transformers.js 3+ crashing iPhone Safari while loading Whisper. Not confirmed on current iOS.
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, env, pipeline } from 'transformers-v2';

import type { Lang, ToWorker } from './messages';
import { TRANSLATION_IDS, errorMessage, isHallucination, post, trackProgress, type Translate } from './worker-shared';

// Models come from the Hugging Face Hub; don't probe this site for a local copy first.
env.allowLocalModels = false;

const WHISPER_ID = 'Xenova/whisper-base';
const MAX_NEW_TOKENS = 128;

// Narrow views of the Transformers.js 2 objects, covering only what this worker calls.
type Processor = (audio: Float32Array) => Promise<{ input_features: unknown }>;
type Tokenizer = {
  decode(ids: number[], options: { skip_special_tokens: boolean }): string;
  get_decoder_prompt_ids(options: { language: string; task: string; no_timestamps: boolean }): number[][];
};
type Whisper = {
  generation_config: {
    lang_to_id: Record<string, number>;
    task_to_id: Record<string, number>;
    no_timestamps_token_id: number;
  };
  generate(inputs: unknown, generation_config: Record<string, unknown>): Promise<number[][]>;
};

let processor: Processor;
let tokenizer: Tokenizer;
let whisper: Whisper;
let translators: Record<Lang, Translate>;
let queue: Promise<void> = Promise.resolve();

async function load() {
  post({ type: 'stage', label: 'speech model (old library)' });
  const whisperProgress = trackProgress();
  processor = (await AutoProcessor.from_pretrained(WHISPER_ID, { progress_callback: whisperProgress })) as unknown as Processor;
  tokenizer = (await AutoTokenizer.from_pretrained(WHISPER_ID, { progress_callback: whisperProgress })) as unknown as Tokenizer;
  whisper = (await WhisperForConditionalGeneration.from_pretrained(WHISPER_ID, {
    quantized: true,
    progress_callback: whisperProgress,
  })) as unknown as Whisper;

  post({ type: 'stage', label: 'Spanish → English model (old library)' });
  const spanishToEnglish = (await pipeline('translation', TRANSLATION_IDS.es, {
    quantized: true,
    progress_callback: trackProgress(),
  })) as unknown as Translate;

  post({ type: 'stage', label: 'English → Spanish model (old library)' });
  const englishToSpanish = (await pipeline('translation', TRANSLATION_IDS.en, {
    quantized: true,
    progress_callback: trackProgress(),
  })) as unknown as Translate;

  translators = { es: spanishToEnglish, en: englishToSpanish };

  post({ type: 'stage', label: 'warm-up (old library)' });
  try {
    await transcribe(new Float32Array(16_000));
  } catch (error) {
    // Only a speed-up for the first phrase; it errored on an iPhone, so don't let it block Start.
    console.warn('Warm-up failed; continuing without it.', error);
  }

  post({ type: 'ready', device: 'wasm' });
}

async function transcribe(audio: Float32Array): Promise<{ language: Lang; confidence: number; text: string }> {
  const { input_features } = await processor(audio);
  const { lang_to_id, task_to_id, no_timestamps_token_id } = whisper.generation_config;

  // Leaving position 1 unforced lets Whisper predict the language token itself (this library skips
  // null entries), while forcing "transcribe" and "no timestamps" keeps timestamp tokens out of the text.
  let [ids] = await whisper.generate(input_features, {
    max_new_tokens: MAX_NEW_TOKENS,
    forced_decoder_ids: [
      [1, null],
      [2, task_to_id.transcribe],
      [3, no_timestamps_token_id],
    ],
  });

  const languageToken = Number(ids[1]);
  let language: Lang | null =
    languageToken === lang_to_id['<|en|>'] ? 'en' : languageToken === lang_to_id['<|es|>'] ? 'es' : null;
  let confidence = 1;

  if (!language) {
    // Whisper sometimes hears Spanish as a nearby language (Portuguese, Galician, …); redo it as Spanish.
    language = 'es';
    confidence = 0.5;
    [ids] = await whisper.generate(input_features, {
      max_new_tokens: MAX_NEW_TOKENS,
      forced_decoder_ids: tokenizer.get_decoder_prompt_ids({ language: 'es', task: 'transcribe', no_timestamps: true }),
    });
  }

  const text = tokenizer
    .decode(ids.map(Number), { skip_special_tokens: true })
    .replace(/<\|[^|]*\|>/g, '')
    .trim();
  return { language, confidence, text };
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
    load().catch((error) => post({ type: 'error', message: `Couldn't load the models: ${errorMessage(error)}` }));
  } else {
    // One phrase at a time; the models can't run concurrently.
    queue = queue
      .then(() => handle(message.id, message.audio))
      .catch((error) => post({ type: 'error', id: message.id, message: errorMessage(error) }));
  }
});
