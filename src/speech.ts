import type { Lang } from './messages';
import { readSetting, writeSetting } from './settings';
import { naturalVoices } from './tts/natural-voices';
import { DEFAULT_NATURAL_VOICE, NATURAL_VOICES, type NaturalVoiceId } from './tts/voices';

/** `natural`: AI voices generated in the page. `device`: the browser's built-in `speechSynthesis` voices. */
export type VoiceStyle = 'natural' | 'device';

const VOICE_TAGS: Record<Lang, string> = { en: 'en-US', es: 'es-ES' };
const VOICE_STYLE_KEY = 'airpod-translator:voice-style';
const preferenceKey = (lang: Lang) => `airpod-translator:voice:${lang}`;
const naturalVoiceKey = (lang: Lang) => `airpod-translator:natural-voice:${lang}`;

// Apple's novelty and legacy voices, which sound robotic.
const LOW_QUALITY =
  /\b(compact|espeak|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;

let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
/** Bumped by `stopSpeaking()` so sentences still arriving from the voice worker aren't played. */
let speechGeneration = 0;
let naturalVoiceErrorHandler: ((message: string) => void) | null = null;

/** Some platforms report tags like `en_US`. */
const normalizeTag = (tag: string) => tag.replace('_', '-');

/** Rough ranking by how human the voice sounds, based on the naming conventions browsers use. */
function quality(voice: SpeechSynthesisVoice, lang: Lang) {
  let score = 0;
  if (/natural|neural|premium/i.test(voice.name)) score += 6;
  if (/enhanced/i.test(voice.name)) score += 4;
  if (/online|google/i.test(voice.name)) score += 3;
  if (normalizeTag(voice.lang) === VOICE_TAGS[lang]) score += 1;
  if (LOW_QUALITY.test(voice.name)) score -= 10;
  return score;
}

/** Device voices for a language, best-sounding first. */
export function voicesFor(lang: Lang): SpeechSynthesisVoice[] {
  return speechSynthesis
    .getVoices()
    .filter((voice) => normalizeTag(voice.lang).toLowerCase().startsWith(lang))
    .sort((a, b) => quality(b, lang) - quality(a, lang) || a.name.localeCompare(b.name));
}

export function getPreferredVoice(lang: Lang): string | null {
  return readSetting(preferenceKey(lang));
}

export function setPreferredVoice(lang: Lang, voiceURI: string) {
  writeSetting(preferenceKey(lang), voiceURI);
}

export function getVoiceStyle(): VoiceStyle {
  return readSetting(VOICE_STYLE_KEY) === 'device' ? 'device' : 'natural';
}

export function setVoiceStyle(style: VoiceStyle) {
  writeSetting(VOICE_STYLE_KEY, style);
}

export function getNaturalVoice(lang: Lang): NaturalVoiceId {
  const saved = readSetting(naturalVoiceKey(lang)) as NaturalVoiceId | null;
  return saved && NATURAL_VOICES[saved]?.lang === lang ? saved : DEFAULT_NATURAL_VOICE[lang];
}

export function setNaturalVoice(lang: Lang, voice: NaturalVoiceId) {
  writeSetting(naturalVoiceKey(lang), voice);
}

/** Called when a natural voice fails and the device voice is used instead. */
export function onNaturalVoiceError(handler: (message: string) => void) {
  naturalVoiceErrorHandler = handler;
}

/** Browsers load voices asynchronously (Chrome returns none at first), so call back when they arrive. */
export function onVoicesChanged(callback: () => void) {
  speechSynthesis.addEventListener('voiceschanged', callback);
  callback();
}

function pickDeviceVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const voices = voicesFor(lang);
  const preferred = getPreferredVoice(lang);
  return voices.find((voice) => voice.voiceURI === preferred) ?? voices[0];
}

/**
 * iOS only allows audio that starts from a tap, so call this synchronously inside Start/Test taps.
 * It unlocks both `speechSynthesis` (silent utterance) and Web Audio (silent buffer) for later playback.
 */
export function unlockSpeech() {
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  speechSynthesis.speak(utterance);

  audioContext ??= new AudioContext();
  void audioContext.resume();
  const silence = audioContext.createBufferSource();
  silence.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
  silence.connect(audioContext.destination);
  silence.start();
}

function playSamples(samples: Float32Array, sampleRate: number): Promise<void> {
  audioContext ??= new AudioContext();
  const context = audioContext;
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);

  return new Promise((resolve) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (currentSource === source) {
        currentSource = null;
      }
      resolve();
    };
    currentSource = source;
    void context.resume().then(() => source.start());
  });
}

/** Resolves when speech ends. Safari sometimes never fires `onend`, so there's a timeout fallback too. */
function speakWithDevice(text: string, lang: Lang): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = VOICE_TAGS[lang];
    const voice = pickDeviceVoice(lang);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }

    const fallback = setTimeout(done, 2_000 + text.length * 90);
    function done() {
      clearTimeout(fallback);
      resolve();
    }
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
  });
}

/** Speaks with the natural voice when it's loaded, otherwise the device voice. Resolves when playback ends. */
export async function speak(text: string, lang: Lang): Promise<void> {
  if (getVoiceStyle() === 'natural') {
    const voice = getNaturalVoice(lang);
    if (naturalVoices.isReady(voice)) {
      const generation = ++speechGeneration;
      // Play each sentence as soon as it's generated, in order.
      let playback: Promise<void> = Promise.resolve();
      try {
        await naturalVoices.synthesize(text, voice, ({ samples, sampleRate }) => {
          playback = playback.then(() =>
            generation === speechGeneration ? playSamples(samples, sampleRate) : undefined,
          );
        });
        await playback;
        return;
      } catch (error) {
        await playback;
        if (generation !== speechGeneration) {
          return;
        }
        naturalVoiceErrorHandler?.(error instanceof Error ? error.message : String(error));
      }
    } else {
      // Not downloaded yet: use the device voice this time and fetch the natural one in the background.
      naturalVoices.load(voice).catch(() => undefined);
    }
  }
  await speakWithDevice(text, lang);
}

export function stopSpeaking() {
  speechGeneration++;
  speechSynthesis.cancel();
  try {
    currentSource?.stop();
  } catch {
    // Not started yet.
  }
  currentSource = null;
}
