import type { Lang } from '../messages';

/**
 * Natural voices generated on-device. English uses Kokoro (graded voices; Heart is the best),
 * Spanish uses Piper because Kokoro's text-to-phoneme step only ships English data for the browser.
 */
export type NaturalVoiceId =
  | 'af_heart'
  | 'af_bella'
  | 'af_nicole'
  | 'en_US-lessac-medium'
  | 'en_US-ryan-medium'
  | 'es_MX-claude-high'
  | 'es_ES-davefx-medium';

export type NaturalVoice = { lang: Lang; label: string; engine: 'kokoro' | 'piper' };

export const NATURAL_VOICES: Record<NaturalVoiceId, NaturalVoice> = {
  af_heart: { lang: 'en', label: 'Heart — most natural', engine: 'kokoro' },
  af_bella: { lang: 'en', label: 'Bella — warm', engine: 'kokoro' },
  af_nicole: { lang: 'en', label: 'Nicole — soft', engine: 'kokoro' },
  // Kokoro needs roughly 2–3 s of work per second of speech on one CPU core; Piper voices are much faster.
  'en_US-lessac-medium': { lang: 'en', label: 'Lessac — faster, less natural', engine: 'piper' },
  'en_US-ryan-medium': { lang: 'en', label: 'Ryan — faster, less natural', engine: 'piper' },
  'es_MX-claude-high': { lang: 'es', label: 'Claude — Mexico', engine: 'piper' },
  'es_ES-davefx-medium': { lang: 'es', label: 'Dave — Spain', engine: 'piper' },
};

export const DEFAULT_NATURAL_VOICE: Record<Lang, NaturalVoiceId> = {
  en: 'af_heart',
  es: 'es_MX-claude-high',
};
