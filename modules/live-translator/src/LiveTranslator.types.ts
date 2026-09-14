export type LanguageCode = 'en' | 'es';

/** Which microphone captures speech. Output always goes to the current route (AirPods). */
export type InputMode = 'phone' | 'airpods';

export type TranslatorState = 'idle' | 'preparing' | 'listening' | 'translating' | 'speaking';

export type StartOptions = {
  inputMode: InputMode;
  /** Speak translations aloud. Defaults to true. */
  speak?: boolean;
};

export type LanguageStatus = {
  /** Speech-recognition models installed for both languages. */
  speechReady: boolean;
  /** Translation packs installed for es→en and en→es. */
  translationReady: boolean;
};

export type TranscriptEvent = {
  id: string;
  text: string;
  language: LanguageCode;
  isFinal: boolean;
};

export type TranslationEvent = {
  id: string;
  sourceText: string;
  sourceLanguage: LanguageCode;
  translatedText: string;
  targetLanguage: LanguageCode;
};

export type StateChangeEvent = {
  state: TranslatorState;
};

export type ErrorEvent = {
  code: string;
  message: string;
};

export type LiveTranslatorModuleEvents = {
  onTranscript: (event: TranscriptEvent) => void;
  onTranslation: (event: TranslationEvent) => void;
  onStateChange: (event: StateChangeEvent) => void;
  onError: (event: ErrorEvent) => void;
};
