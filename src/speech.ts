import type { Lang } from './messages';

const VOICE_TAGS: Record<Lang, string> = { en: 'en-US', es: 'es-ES' };

// Apple's novelty and legacy voices, which sound robotic.
const LOW_QUALITY =
  /\b(compact|espeak|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;

const preferenceKey = (lang: Lang) => `airpod-translator:voice:${lang}`;

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

/** Voices for a language, best-sounding first. */
export function voicesFor(lang: Lang): SpeechSynthesisVoice[] {
  return speechSynthesis
    .getVoices()
    .filter((voice) => normalizeTag(voice.lang).toLowerCase().startsWith(lang))
    .sort((a, b) => quality(b, lang) - quality(a, lang) || a.name.localeCompare(b.name));
}

export function getPreferredVoice(lang: Lang): string | null {
  try {
    return localStorage.getItem(preferenceKey(lang));
  } catch {
    return null;
  }
}

export function setPreferredVoice(lang: Lang, voiceURI: string) {
  try {
    localStorage.setItem(preferenceKey(lang), voiceURI);
  } catch {
    // Storage unavailable; the best-ranked voice is used instead.
  }
}

/** Browsers load voices asynchronously (Chrome returns none at first), so call back when they arrive. */
export function onVoicesChanged(callback: () => void) {
  speechSynthesis.addEventListener('voiceschanged', callback);
  callback();
}

function pickVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const voices = voicesFor(lang);
  const preferred = getPreferredVoice(lang);
  return voices.find((voice) => voice.voiceURI === preferred) ?? voices[0];
}

/** iOS only allows speech that starts from a tap, so speak something silent during the Start tap. */
export function unlockSpeech() {
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  speechSynthesis.speak(utterance);
}

/** Resolves when speech ends. Safari sometimes never fires `onend`, so there's a timeout fallback too. */
export function speak(text: string, lang: Lang): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = VOICE_TAGS[lang];
    const voice = pickVoice(lang);
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

export function stopSpeaking() {
  speechSynthesis.cancel();
}
