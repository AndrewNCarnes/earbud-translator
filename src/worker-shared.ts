// Shared by the on-device AI workers (`worker.ts` and the experimental `worker-legacy.ts`).
import type { FromWorker, Lang } from './messages';

export const TRANSLATION_IDS: Record<Lang, string> = {
  es: 'Xenova/opus-mt-es-en',
  en: 'Xenova/opus-mt-en-es',
};

export type Translate = (text: string) => Promise<{ translation_text: string }[]>;

// Whisper tends to invent these on silence or background noise.
const HALLUCINATIONS = new Set([
  'you',
  '...',
  'thank you.',
  'thanks for watching!',
  'thank you for watching.',
  'gracias.',
  'gracias por ver el video.',
  'subtítulos realizados por la comunidad de amara.org',
]);

export const isHallucination = (text: string) => !text || HALLUCINATIONS.has(text.toLowerCase());

export function post(message: FromWorker) {
  self.postMessage(message);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type ProgressEvent = { status: string; name?: string; file?: string; loaded?: number; total?: number };

/** Sums byte progress across every file of one model into one overall figure. */
export function trackProgress() {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info: ProgressEvent) => {
    if (info.status !== 'progress' || !info.file) {
      return;
    }
    files.set(`${info.name}/${info.file}`, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    post({ type: 'progress', loaded, total });
  };
}
