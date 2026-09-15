import type { Lang } from './messages';

const ENDPOINT = 'https://api.mymemory.translated.net/get';
/** MyMemory rejects queries over 500 bytes, so longer text is split between words. */
const MAX_QUERY_BYTES = 450;

const QUOTA_MESSAGE =
  "Today's free translation limit is used up. Add an email in Settings to raise it from 5,000 to 50,000 characters a day, or try again tomorrow.";

type MyMemoryResponse = {
  responseData?: { translatedText?: string };
  responseStatus?: number | string;
  responseDetails?: string;
  quotaFinished?: boolean;
};

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

function splitForQuery(text: string): string[] {
  if (byteLength(text) <= MAX_QUERY_BYTES) {
    return [text];
  }
  const chunks: string[] = [];
  let current = '';
  for (const word of text.split(/(?<=\s)/)) {
    if (current && byteLength(current + word) > MAX_QUERY_BYTES) {
      chunks.push(current.trim());
      current = '';
    }
    current += word;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

/** MyMemory sometimes returns HTML entities such as `&#39;`. */
function decodeEntities(text: string) {
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent ?? text;
}

async function translateChunk(text: string, from: Lang, to: Lang, email?: string): Promise<string> {
  const params = new URLSearchParams({ q: text, langpair: `${from}|${to}` });
  if (email) {
    // Raises the free limit tenfold; only sent when the user has entered an address.
    params.set('de', email);
  }

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${params}`);
  } catch {
    throw new Error("Couldn't reach the translation service. Check your internet connection.");
  }

  const data = (await response.json().catch(() => null)) as MyMemoryResponse | null;
  const translated = data?.responseData?.translatedText ?? '';

  if (response.status === 429 || data?.quotaFinished || /MYMEMORY WARNING/i.test(translated)) {
    throw new Error(QUOTA_MESSAGE);
  }
  if (!response.ok || Number(data?.responseStatus) !== 200 || !translated) {
    throw new Error(`Translation failed: ${data?.responseDetails || response.statusText || 'unknown error'}`);
  }
  return decodeEntities(translated);
}

/** Translates with the free MyMemory API (5,000 characters a day, or 50,000 with an email). */
export async function translateOnline(text: string, from: Lang, to: Lang, email?: string): Promise<string> {
  const translated: string[] = [];
  for (const chunk of splitForQuery(text)) {
    translated.push(await translateChunk(chunk, from, to, email));
  }
  return translated.join(' ');
}
