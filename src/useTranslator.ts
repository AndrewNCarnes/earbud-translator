import { useEventListener } from 'expo';
import { useCallback, useEffect, useState } from 'react';

import LiveTranslator, {
  ErrorEvent,
  InputMode,
  LanguageStatus,
  TranscriptEvent,
  TranslationEvent,
  TranslatorState,
} from '../modules/live-translator';

const MAX_ENTRIES = 100;

function toError(error: unknown): ErrorEvent {
  return { code: 'js_error', message: error instanceof Error ? error.message : String(error) };
}

export function useTranslator() {
  const [state, setState] = useState<TranslatorState>('idle');
  const [entries, setEntries] = useState<TranslationEvent[]>([]);
  const [live, setLive] = useState<TranscriptEvent | null>(null);
  const [error, setError] = useState<ErrorEvent | null>(null);
  const [languageStatus, setLanguageStatus] = useState<LanguageStatus | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEventListener(LiveTranslator, 'onStateChange', (event) => setState(event.state));
  useEventListener(LiveTranslator, 'onTranscript', (event) => setLive(event.isFinal ? null : event));
  useEventListener(LiveTranslator, 'onTranslation', (event) =>
    setEntries((previous) => [event, ...previous].slice(0, MAX_ENTRIES))
  );
  useEventListener(LiveTranslator, 'onError', setError);

  useEffect(() => {
    LiveTranslator.getLanguageStatus()
      .then(setLanguageStatus)
      .catch((e) => setError(toError(e)));
  }, []);

  const downloadLanguages = useCallback(async () => {
    setError(null);
    setDownloading(true);
    try {
      setLanguageStatus(await LiveTranslator.downloadLanguages());
    } catch (e) {
      setError(toError(e));
    } finally {
      setDownloading(false);
    }
  }, []);

  const start = useCallback(async (inputMode: InputMode) => {
    setError(null);
    try {
      if (!(await LiveTranslator.requestPermissions())) {
        throw new Error('Microphone and speech recognition permissions are required. Enable them in Settings.');
      }
      await LiveTranslator.start({ inputMode });
    } catch (e) {
      setError(toError(e));
    }
  }, []);

  const stop = useCallback(async () => {
    setLive(null);
    await LiveTranslator.stop().catch((e) => setError(toError(e)));
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  const languagesReady = !!languageStatus?.speechReady && !!languageStatus?.translationReady;

  return { state, entries, live, error, languageStatus, languagesReady, downloading, downloadLanguages, start, stop, clear };
}
