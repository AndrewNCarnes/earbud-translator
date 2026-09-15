// Generates natural speech on-device: Kokoro for English, Piper for Spanish.
// Runs ONNX Runtime directly rather than through Transformers.js, whose Whisper loading crashes iPhone Safari.
import * as ort from 'onnxruntime-web/wasm';
import { phonemize as espeak } from 'phonemizer';

import { createPiperPhonemize } from '../vendor/piper-phonemize.js';
import type { FromTts, ToTts } from './messages';
import { NATURAL_VOICES, type NaturalVoiceId } from './voices';

/** Must not start with "airpod-translator-": the service worker deletes those caches on update. */
const CACHE_NAME = 'natural-voices-v1';

const KOKORO_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
const KOKORO_SAMPLE_RATE = 24_000;
const KOKORO_STYLE_DIM = 256;
/** Kokoro's context is 512 tokens including the start and end padding. */
const KOKORO_MAX_TOKENS = 510;

const PIPER_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const PIPER_PHONEMIZE_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const PIPER_MODEL_PATHS: Partial<Record<NaturalVoiceId, string>> = {
  'en_US-lessac-medium': 'en/en_US/lessac/medium/en_US-lessac-medium.onnx',
  'en_US-ryan-medium': 'en/en_US/ryan/medium/en_US-ryan-medium.onnx',
  'es_MX-claude-high': 'es/es_MX/claude/high/es_MX-claude-high.onnx',
  'es_ES-davefx-medium': 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx',
};

// The quantized models trip ONNX Runtime's extended QDQ optimizations, as they do for the translation models.
const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'basic',
};
let kokoroModelFile = 'model_quantized';

type PiperConfig = {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  speaker_id_map?: Record<string, number>;
};

type Audio = { samples: Float32Array; sampleRate: number };

let kokoroSession: ort.InferenceSession | null = null;
let kokoroVocab: Map<string, number> | null = null;
const kokoroStyles = new Map<NaturalVoiceId, Float32Array>();
const piperVoices = new Map<NaturalVoiceId, { session: ort.InferenceSession; config: PiperConfig }>();
let queue: Promise<void> = Promise.resolve();

function post(message: FromTts, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Downloads a file once and keeps it in Cache Storage, reporting byte progress along the way. */
async function fetchCached(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      return await cached.arrayBuffer();
    }
  } catch {
    // Cache Storage unavailable; download every time instead.
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't download ${url.split('/').pop()} (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total || loaded);
  }

  const blob = new Blob(chunks as BlobPart[]);
  try {
    await cache?.put(url, new Response(blob));
  } catch {
    // Out of storage quota; the file just isn't cached.
  }
  return blob.arrayBuffer();
}

function progressReporter(voice: NaturalVoiceId) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (file: string) => (loaded: number, total: number) => {
    files.set(file, { loaded, total });
    let sumLoaded = 0;
    let sumTotal = 0;
    for (const entry of files.values()) {
      sumLoaded += entry.loaded;
      sumTotal += entry.total;
    }
    post({ type: 'progress', voice, loaded: sumLoaded, total: sumTotal });
  };
}

// ── Kokoro (English) ────────────────────────────────────────────────────────────────────────────
// Text normalization and phoneme fixes are ported from kokoro-js (Apache-2.0), American English only.

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${escapeRegExp(PUNCTUATION)}]+\\s*)+`, 'g');

/** Years and times as spoken: "1990" → "19 90", "3:05" → "3 oh 5". */
function speakNumber(match: string): string {
  if (match.includes('.')) {
    return match;
  }
  if (match.includes(':')) {
    const [hours, minutes] = match.split(':').map(Number);
    if (minutes === 0) return `${hours} o'clock`;
    if (minutes < 10) return `${hours} oh ${minutes}`;
    return `${hours} ${minutes}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) {
    return match;
  }
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function speakMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) {
    return `${match.slice(1)} ${bill}s`;
  }
  if (!match.includes('.')) {
    return `${match.slice(1)} ${bill}${match.slice(1) === '1' ? '' : 's'}`;
  }
  const [whole, fraction] = match.slice(1).split('.');
  const cents = parseInt(fraction.padEnd(2, '0'), 10);
  const coin = match[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${whole} ${bill}${whole === '1' ? '' : 's'} and ${cents} ${coin}`;
}

function speakDecimal(match: string): string {
  const [whole, fraction] = match.split('.');
  return `${whole} point ${fraction.split('').join(' ')}`;
}

function normalizeEnglish(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, speakNumber)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, speakMoney)
    .replace(/\d*\.\d+/g, speakDecimal)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (match) => match.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

/** Phonemizes the words but keeps punctuation as-is, which Kokoro uses for pauses and intonation. */
async function phonemizeEnglish(text: string): Promise<string> {
  const normalized = normalizeEnglish(text);
  const parts: { punctuation: boolean; text: string }[] = [];
  let last = 0;
  for (const match of normalized.matchAll(PUNCTUATION_PATTERN)) {
    if (last < match.index) {
      parts.push({ punctuation: false, text: normalized.slice(last, match.index) });
    }
    if (match[0].length > 0) {
      parts.push({ punctuation: true, text: match[0] });
    }
    last = match.index + match[0].length;
  }
  if (last < normalized.length) {
    parts.push({ punctuation: false, text: normalized.slice(last) });
  }

  const phonemized = await Promise.all(
    parts.map(async (part) => (part.punctuation ? part.text : (await espeak(part.text, 'en-us')).join(' '))),
  );
  return phonemized
    .join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    .replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
    .trim();
}

async function loadKokoro(voice: NaturalVoiceId) {
  const report = progressReporter(voice);
  if (!kokoroSession || !kokoroVocab) {
    const [tokenizer, model] = await Promise.all([
      fetchCached(`${KOKORO_BASE}/tokenizer.json`),
      fetchCached(`${KOKORO_BASE}/onnx/${kokoroModelFile}.onnx`, report('model')),
    ]);
    const vocab = (JSON.parse(new TextDecoder().decode(tokenizer)) as { model: { vocab: Record<string, number> } }).model.vocab;
    kokoroVocab = new Map(Object.entries(vocab));
    kokoroSession = await ort.InferenceSession.create(new Uint8Array(model), SESSION_OPTIONS);
  }
  if (!kokoroStyles.has(voice)) {
    kokoroStyles.set(voice, new Float32Array(await fetchCached(`${KOKORO_BASE}/voices/${voice}.bin`, report('voice'))));
  }
}

async function synthesizeKokoroSentence(text: string, voice: NaturalVoiceId): Promise<Float32Array> {
  const vocab = kokoroVocab!;
  const phonemizeStarted = performance.now();
  const phonemes = await phonemizeEnglish(text);
  const phonemizeMs = performance.now() - phonemizeStarted;
  // Characters outside the vocabulary are dropped, matching the tokenizer's normalizer.
  const tokens = [...phonemes]
    .map((symbol) => vocab.get(symbol))
    .filter((id): id is number => id !== undefined)
    .slice(0, KOKORO_MAX_TOKENS);
  if (tokens.length === 0) {
    return new Float32Array(0);
  }

  const inputIds = new BigInt64Array(tokens.length + 2); // Padded with id 0 ("$") at both ends.
  tokens.forEach((id, index) => {
    inputIds[index + 1] = BigInt(id);
  });
  // Each voice file holds one style vector per possible token count.
  const offset = Math.min(tokens.length, KOKORO_MAX_TOKENS - 1) * KOKORO_STYLE_DIM;
  const style = kokoroStyles.get(voice)!.slice(offset, offset + KOKORO_STYLE_DIM);

  const runStarted = performance.now();
  const { waveform } = await kokoroSession!.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, inputIds.length]),
    style: new ort.Tensor('float32', style, [1, KOKORO_STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([1]), [1]),
  });
  const samples = (waveform.data as Float32Array).slice();
  console.debug(
    `[kokoro] ${tokens.length} tokens → ${(samples.length / KOKORO_SAMPLE_RATE).toFixed(1)}s audio: ` +
      `phonemize ${phonemizeMs.toFixed(0)} ms, model ${(performance.now() - runStarted).toFixed(0)} ms`,
  );
  return samples;
}

// ── Piper (Spanish) ─────────────────────────────────────────────────────────────────────────────

async function loadPiper(voice: NaturalVoiceId) {
  if (piperVoices.has(voice)) {
    return;
  }
  const path = PIPER_MODEL_PATHS[voice];
  if (!path) {
    throw new Error(`Unknown Piper voice ${voice}.`);
  }
  const report = progressReporter(voice);
  const [configBuffer, model] = await Promise.all([
    fetchCached(`${PIPER_BASE}/${path}.json`),
    fetchCached(`${PIPER_BASE}/${path}`, report('model')),
  ]);
  const config = JSON.parse(new TextDecoder().decode(configBuffer)) as PiperConfig;
  const session = await ort.InferenceSession.create(new Uint8Array(model), SESSION_OPTIONS);
  piperVoices.set(voice, { session, config });
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  console.debug(`[${label}] ${(performance.now() - started).toFixed(0)} ms`);
  return result;
}

/** Piper's own espeak-ng build (with Spanish data) turns text into the voice's phoneme ids. */
function piperPhonemeIds(text: string, espeakVoice: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    createPiperPhonemize({
      print: (line) => resolve((JSON.parse(line) as { phoneme_ids: number[] }).phoneme_ids),
      printErr: (line) => {
        if (line.trim()) {
          reject(new Error(line));
        }
      },
      locateFile: (file) =>
        file.endsWith('.wasm') ? `${PIPER_PHONEMIZE_BASE}.wasm` : file.endsWith('.data') ? `${PIPER_PHONEMIZE_BASE}.data` : file,
    })
      .then((module) =>
        module.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']),
      )
      .catch(reject);
  });
}

async function synthesizePiper(text: string, voice: NaturalVoiceId): Promise<Audio> {
  const { session, config } = piperVoices.get(voice)!;
  const ids = await timed('piper phonemize', () => piperPhonemeIds(text, config.espeak.voice));
  const { noise_scale, length_scale, noise_w } = config.inference;

  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
  };
  if (Object.keys(config.speaker_id_map ?? {}).length > 0) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  }
  const { output } = await timed('piper model', () => session.run(feeds));
  return { samples: (output.data as Float32Array).slice(), sampleRate: config.audio.sample_rate };
}

// ── Shared ──────────────────────────────────────────────────────────────────────────────────────

async function loadVoice(voice: NaturalVoiceId) {
  if (NATURAL_VOICES[voice].engine === 'kokoro') {
    await loadKokoro(voice);
  } else {
    await loadPiper(voice);
  }
}

/** Splits at sentence ends followed by whitespace (so "3.5" stays whole). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

async function synthesizeSentence(sentence: string, voice: NaturalVoiceId): Promise<Audio> {
  if (NATURAL_VOICES[voice].engine === 'piper') {
    return synthesizePiper(sentence, voice);
  }
  return { samples: await synthesizeKokoroSentence(sentence, voice), sampleRate: KOKORO_SAMPLE_RATE };
}

/**
 * Sends audio one sentence at a time so playback can start before the whole reply is generated;
 * the model is slower than real time on one CPU core. Per-sentence calls also keep Kokoro under its token limit.
 */
async function synthesize(id: number, text: string, voice: NaturalVoiceId) {
  await loadVoice(voice);
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    post({ type: 'audio', id, samples: new Float32Array(0), sampleRate: KOKORO_SAMPLE_RATE, done: true });
    return;
  }
  for (const [index, sentence] of sentences.entries()) {
    const audio = await synthesizeSentence(sentence, voice);
    post({ type: 'audio', id, ...audio, done: index === sentences.length - 1 }, [audio.samples.buffer]);
  }
}

self.addEventListener('message', (event: MessageEvent<ToTts>) => {
  const message = event.data;
  if (message.type === 'init') {
    ort.env.wasm.wasmPaths = message.assetBase;
    if (message.kokoroModel) {
      kokoroModelFile = message.kokoroModel;
    }
    if (message.graphOptimization) {
      SESSION_OPTIONS.graphOptimizationLevel = message.graphOptimization;
    }
    // Multithreading needs cross-origin isolation, which GitHub Pages can't provide.
    ort.env.wasm.numThreads = 1;
    return;
  }

  // One job at a time; the models share this worker's memory.
  queue = queue.then(async () => {
    if (message.type === 'load') {
      try {
        await loadVoice(message.voice);
        post({ type: 'loaded', voice: message.voice });
      } catch (error) {
        post({ type: 'error', voice: message.voice, message: errorMessage(error) });
      }
    } else {
      try {
        await synthesize(message.id, message.text, message.voice);
      } catch (error) {
        post({ type: 'error', id: message.id, message: errorMessage(error) });
      }
    }
  });
});
