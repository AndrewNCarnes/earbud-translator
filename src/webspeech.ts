import type { Lang } from './messages';

export type SpanishAccent = 'es-US' | 'es-MX' | 'es-ES';
export const SPANISH_ACCENTS: SpanishAccent[] = ['es-US', 'es-MX', 'es-ES'];

const RESTART_DELAY_MS = 200;
/** iOS sometimes stops sending results without ending the session; after this long, end it ourselves. */
const STALL_MS = 1_500;
/** Errors that are often temporary on iOS get this many retries (with growing delays) before giving up. */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

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
  stop(): void;
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

/** Errors that restarting won't fix. */
const FATAL_ERRORS: Record<string, string> = {
  'not-allowed':
    'Speech recognition was blocked. Allow the microphone and speech recognition for this site, then tap Start again.',
  'service-not-allowed':
    "Speech recognition isn't available. Turn on Siri & Dictation in Settings → Siri, then tap Start again.",
  'language-not-supported':
    "Safari speech recognition doesn't support this language here. Try another Spanish accent in Settings, or the experimental on-device AI engine.",
};

/** Errors that are often temporary on iOS; these messages are shown only once retries run out. */
const RECOVERABLE_ERRORS: Record<string, string> = {
  'audio-capture':
    'Safari speech recognition keeps losing the microphone. For Spanish, the experimental on-device AI engine in Settings is more reliable on iPhone.',
  network: 'Safari speech recognition needs an internet connection.',
};

type ListenerOptions = {
  getLanguage: () => Lang;
  /** Recognition tag for a language, e.g. the chosen Spanish accent. */
  getLanguageTag: (language: Lang) => string;
  onHearing: () => void;
  onPhrase: (text: string, language: Lang) => void;
  /** Listening has stopped for good (permission denied, retries exhausted, …). */
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
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private consecutiveErrors = 0;
  private nextRestartDelay = RESTART_DELAY_MS;
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
    this.consecutiveErrors = 0;
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
    this.recognition.lang = this.options.getLanguageTag(this.sessionLanguage);
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
    clearTimeout(this.stallTimer);
    this.discardCurrent = true;
    this.recognition.abort();
  }

  private scheduleRestart(delay = RESTART_DELAY_MS) {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.begin(), delay);
  }

  /** Ends a session whose results stopped arriving, so the text heard so far still gets translated. */
  private watchForStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if ((this.finalText || this.interimText).trim()) {
        try {
          this.recognition.stop();
        } catch {
          // Already ended.
        }
      }
    }, STALL_MS);
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
    this.consecutiveErrors = 0;
    this.options.onHearing();
    this.watchForStall();
  }

  private handleError(event: RecognitionErrorEvent) {
    const fatal = FATAL_ERRORS[event.error];
    if (fatal) {
      this.active = false;
      this.options.onFatalError(fatal);
      return;
    }
    const recoverable = RECOVERABLE_ERRORS[event.error];
    if (recoverable) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors > MAX_RETRIES) {
        this.active = false;
        this.options.onFatalError(recoverable);
      } else {
        this.nextRestartDelay = RETRY_BASE_DELAY_MS * 2 ** (this.consecutiveErrors - 1);
      }
    }
    // 'no-speech' and 'aborted' are routine; `onend` restarts listening.
  }

  private handleEnd() {
    clearTimeout(this.stallTimer);
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
      this.scheduleRestart(this.nextRestartDelay);
    }
    this.nextRestartDelay = RESTART_DELAY_MS;
  }
}
