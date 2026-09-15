import type { Lang } from './messages';

const RECOGNITION_TAGS: Record<Lang, string> = { en: 'en-US', es: 'es-ES' };
const RESTART_DELAY_MS = 200;

// Minimal typings: TypeScript's DOM lib doesn't include the Web Speech recognition API (still prefixed in Safari).
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: { readonly transcript: string } | undefined;
}
interface RecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}
interface RecognitionErrorEvent extends Event {
  readonly error: string;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export const isWebSpeechSupported = () => !!recognitionConstructor();

/** Errors that won't fix themselves by restarting. Others ('no-speech', 'aborted') are routine. */
const FATAL_ERRORS: Record<string, string> = {
  'not-allowed':
    'Speech recognition was blocked. Allow the microphone and speech recognition for this site, then tap Start again.',
  'service-not-allowed':
    "Speech recognition isn't available. Turn on Siri & Dictation in Settings → Siri, then tap Start again.",
  'audio-capture': 'No microphone was found.',
  network: 'Safari speech recognition needs an internet connection.',
  'language-not-supported': "This language isn't supported by speech recognition on this device.",
};

type ListenerOptions = {
  getLanguage: () => Lang;
  onHearing: () => void;
  onPhrase: (text: string, language: Lang) => void;
  /** Listening has stopped for good (permission denied, no internet, …). */
  onFatalError: (message: string) => void;
};

/**
 * Listens one phrase at a time with the browser's built-in speech recognition, restarting after each.
 * iOS handles `continuous = true` badly (it stalls or stops on its own), so single-shot plus restart is steadier.
 * One reused instance avoids iOS playing a chime for every new recognizer.
 */
export class WebSpeechListener {
  private readonly recognition: Recognition;
  private active = false;
  private paused = false;
  private discardCurrent = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionLanguage: Lang = 'es';
  private finalText = '';
  private interimText = '';

  constructor(private readonly options: ListenerOptions) {
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      throw new Error("This browser doesn't have built-in speech recognition. Choose On-device AI in Settings.");
    }
    this.recognition = new Recognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.onresult = (event) => this.handleResult(event);
    this.recognition.onerror = (event) => this.handleError(event);
    this.recognition.onend = () => this.handleEnd();
  }

  start() {
    this.active = true;
    this.paused = false;
    this.begin();
  }

  stop() {
    this.active = false;
    this.abortSession();
  }

  /** Stops listening while translations are spoken, so the app doesn't hear itself. */
  pause() {
    this.paused = true;
    this.abortSession();
  }

  resume() {
    if (this.active && this.paused) {
      this.paused = false;
      this.scheduleRestart();
    }
  }

  /** Drops the phrase in progress and starts over, e.g. after the listening language changes. */
  restart() {
    if (this.active && !this.paused) {
      this.abortSession();
      this.scheduleRestart();
    }
  }

  private begin() {
    if (!this.active || this.paused) {
      return;
    }
    this.sessionLanguage = this.options.getLanguage();
    this.recognition.lang = RECOGNITION_TAGS[this.sessionLanguage];
    this.finalText = '';
    this.interimText = '';
    try {
      this.recognition.start();
    } catch {
      // Already running; its `onend` schedules the next start.
    }
  }

  private abortSession() {
    clearTimeout(this.restartTimer);
    this.discardCurrent = true;
    this.recognition.abort();
  }

  private scheduleRestart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.begin(), RESTART_DELAY_MS);
  }

  private handleResult(event: RecognitionResultEvent) {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        this.finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    this.interimText = interim;
    this.options.onHearing();
  }

  private handleError(event: RecognitionErrorEvent) {
    const message = FATAL_ERRORS[event.error];
    if (message) {
      this.active = false;
      this.options.onFatalError(message);
    }
  }

  private handleEnd() {
    // iOS sometimes ends a session without marking the last result final, so fall back to the interim text.
    const text = (this.finalText || this.interimText).trim();
    const discard = this.discardCurrent;
    this.discardCurrent = false;
    this.finalText = '';
    this.interimText = '';

    if (text && !discard && this.active) {
      this.options.onPhrase(text, this.sessionLanguage);
    }
    if (this.active && !this.paused) {
      this.scheduleRestart();
    }
  }
}
