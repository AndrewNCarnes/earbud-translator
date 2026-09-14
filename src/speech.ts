import type { Lang } from './messages';

const VOICE_TAGS: Record<Lang, string> = { en: 'en-US', es: 'es-ES' };

/** iOS only allows speech that starts from a tap, so speak something silent during the Start tap. */
export function unlockSpeech() {
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  speechSynthesis.speak(utterance);
}

function pickVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const tag = VOICE_TAGS[lang];
  return (
    voices.find((voice) => voice.lang === tag && voice.localService) ??
    voices.find((voice) => voice.lang === tag) ??
    voices.find((voice) => voice.lang.startsWith(lang))
  );
}

/** Resolves when speech ends. Safari sometimes never fires `onend`, so there's a timeout fallback too. */
export function speak(text: string, lang: Lang): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = VOICE_TAGS[lang];
    const voice = pickVoice(lang);
    if (voice) {
      utterance.voice = voice;
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
