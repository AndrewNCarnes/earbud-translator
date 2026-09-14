import './style.css';

import type { MicVAD } from '@ricky0123/vad-web';

import { createListener, listMicrophones } from './audio';
import { OTHER, type FromWorker, type Lang, type ToWorker } from './messages';
import {
  getPreferredVoice,
  onVoicesChanged,
  setPreferredVoice,
  speak,
  stopSpeaking,
  unlockSpeech,
  voicesFor,
} from './speech';

const FLAGS: Record<Lang, string> = { en: '🇺🇸', es: '🇪🇸' };
const LANGS: Lang[] = ['en', 'es'];
const VOICE_SAMPLES: Record<Lang, string> = {
  en: 'Hi! This is how your translations will sound.',
  es: '¡Hola! Así sonarán tus traducciones.',
};
const MODELS_CACHED_KEY = 'airpod-translator:models-cached';
const INSTALL_HINT_DISMISSED_KEY = 'airpod-translator:install-hint-dismissed';
/** Ignore the mic briefly after speaking so the tail of the voice isn't picked up. */
const ECHO_TAIL_MS = 300;

type Status = 'idle' | 'loading' | 'listening' | 'hearing' | 'translating' | 'speaking';

const STATUS_LABELS: Record<Status, string> = {
  idle: 'Stopped',
  loading: 'Loading models…',
  listening: 'Listening',
  hearing: 'Hearing speech…',
  translating: 'Translating…',
  speaking: 'Speaking',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusDot = $('status-dot');
const statusText = $('status-text');
const progress = $('progress');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const micSelect = $<HTMLSelectElement>('mic');
const errorBox = $('error');
const list = $('entries');
const empty = $('empty');
const mainButton = $<HTMLButtonElement>('main-button');
const voiceSelects: Record<Lang, HTMLSelectElement> = {
  en: $<HTMLSelectElement>('voice-en'),
  es: $<HTMLSelectElement>('voice-es'),
};

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

let modelsReady: Promise<void> | null = null;
let listener: MicVAD | null = null;
let running = false;
let speaking = false;
let ignoreUntil = 0;
let hearingIgnored = false;
let pending = 0;
let nextId = 0;
let speechChain: Promise<void> = Promise.resolve();
let wakeLock: WakeLockSentinel | null = null;

function send(message: ToWorker, transfer: Transferable[] = []) {
  worker.postMessage(message, transfer);
}

function setStatus(status: Status) {
  statusText.textContent = STATUS_LABELS[status];
  statusDot.dataset.state = status;
}

function refreshStatus() {
  if (!running) {
    setStatus('idle');
  } else if (speaking) {
    setStatus('speaking');
  } else if (pending > 0) {
    setStatus('translating');
  } else {
    setStatus('listening');
  }
}

function showError(message: string | null) {
  errorBox.hidden = !message;
  errorBox.textContent = message ?? '';
}

function formatMB(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function loadModels(): Promise<void> {
  modelsReady ??= new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onWorkerError);
      progress.hidden = true;
    };
    const fail = (message: string) => {
      cleanup();
      modelsReady = null;
      reject(new Error(message));
    };
    // Fires if the worker script itself can't load or throws outside a message handler.
    const onWorkerError = (event: ErrorEvent) => {
      fail(`The translator failed to start: ${event.message || 'unknown error'}`);
    };
    const onMessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === 'progress' && message.total > 0) {
        progress.hidden = false;
        progressBar.style.width = `${Math.min(100, (message.loaded / message.total) * 100)}%`;
        progressText.textContent = `Downloading models: ${formatMB(message.loaded)} of ${formatMB(message.total)} (one time only)`;
      } else if (message.type === 'ready') {
        cleanup();
        try {
          localStorage.setItem(MODELS_CACHED_KEY, '1');
        } catch {
          // Storage can be unavailable (e.g. private browsing); models just won't preload next time.
        }
        resolve();
      } else if (message.type === 'error' && message.id === undefined) {
        fail(message.message);
      }
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onWorkerError);
    send({ type: 'load' });
  });
  return modelsReady;
}

worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
  const message = event.data;
  if (message.type === 'result') {
    pending = Math.max(0, pending - 1);
    addEntry(message.language, message.text, message.translation);
    enqueueSpeech(message.translation, OTHER[message.language]);
    refreshStatus();
  } else if (message.type === 'skip') {
    pending = Math.max(0, pending - 1);
    refreshStatus();
  } else if (message.type === 'error' && message.id !== undefined) {
    pending = Math.max(0, pending - 1);
    showError(message.message);
    refreshStatus();
  }
});

function addEntry(source: Lang, text: string, translation: string) {
  empty.hidden = true;
  const card = document.createElement('article');
  card.className = 'card';

  const original = document.createElement('p');
  original.className = 'source';
  original.textContent = `${FLAGS[source]} ${text}`;

  const translated = document.createElement('p');
  translated.className = 'translation';
  translated.textContent = `${FLAGS[OTHER[source]]} ${translation}`;

  card.append(original, translated);
  list.prepend(card);
}

function enqueueSpeech(text: string, lang: Lang) {
  speechChain = speechChain.then(async () => {
    if (!running) {
      return;
    }
    speaking = true;
    refreshStatus();
    await speak(text, lang);
    ignoreUntil = performance.now() + ECHO_TAIL_MS;
    speaking = false;
    refreshStatus();
  });
}

async function populateMicrophones() {
  const selected = micSelect.value;
  const microphones = await listMicrophones();
  micSelect.replaceChildren(
    ...microphones.map((mic, index) => new Option(mic.label || `Microphone ${index + 1}`, mic.deviceId)),
  );
  // Prefer the phone's own mic: AirPods mics are tuned to the wearer's voice and filter out other people.
  const preferred =
    microphones.find((mic) => mic.deviceId === selected) ??
    microphones.find((mic) => /iphone|built-in|internal/i.test(mic.label));
  if (preferred) {
    micSelect.value = preferred.deviceId;
  }
}

async function startListening() {
  listener = await createListener({
    deviceId: micSelect.value || undefined,
    onSpeechStart: () => {
      // Speech that starts while the app is talking is almost certainly its own voice.
      hearingIgnored = speaking || performance.now() < ignoreUntil;
      if (!hearingIgnored) {
        setStatus('hearing');
      }
    },
    onSpeechEnd: (audio) => {
      if (hearingIgnored || speaking) {
        hearingIgnored = false;
        return;
      }
      pending += 1;
      refreshStatus();
      send({ type: 'process', id: nextId++, audio }, [audio.buffer]);
    },
    onMisfire: refreshStatus,
  });
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Not supported or refused; the screen may dim, which pauses the page on iOS.
  }
}

async function start() {
  showError(null);
  // Must happen synchronously inside the tap for iOS to allow speech later.
  unlockSpeech();
  running = true;
  mainButton.disabled = true;
  setStatus('loading');

  try {
    await Promise.all([loadModels(), requestWakeLock()]);
    await startListening();
    // Device labels are only visible after mic permission is granted.
    await populateMicrophones();
    mainButton.textContent = 'Stop';
    mainButton.classList.add('stop');
    refreshStatus();
  } catch (error) {
    await stop();
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    mainButton.disabled = false;
  }
}

async function stop() {
  running = false;
  speaking = false;
  pending = 0;
  stopSpeaking();
  await listener?.destroy();
  listener = null;
  await wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  mainButton.textContent = 'Start';
  mainButton.classList.remove('stop');
  refreshStatus();
}

mainButton.addEventListener('click', () => {
  void (running ? stop() : start());
});

micSelect.addEventListener('change', async () => {
  if (!running) {
    return;
  }
  await listener?.destroy();
  await startListening().catch((error) => showError(String(error)));
});

// iOS drops the wake lock whenever the page is hidden.
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') {
    void requestWakeLock();
  }
});

navigator.mediaDevices?.addEventListener('devicechange', () => {
  void populateMicrophones();
});

function populateVoices() {
  for (const lang of LANGS) {
    const select = voiceSelects[lang];
    const voices = voicesFor(lang);
    select.replaceChildren(
      ...voices.map((voice) => new Option(voice.localService ? voice.name : `${voice.name} (needs internet)`, voice.voiceURI)),
    );
    const preferred = getPreferredVoice(lang);
    if (preferred && voices.some((voice) => voice.voiceURI === preferred)) {
      select.value = preferred;
    }
    select.disabled = voices.length === 0;
  }
}

for (const lang of LANGS) {
  voiceSelects[lang].addEventListener('change', () => setPreferredVoice(lang, voiceSelects[lang].value));
}

document.querySelectorAll<HTMLButtonElement>('.test-voice').forEach((button) => {
  button.addEventListener('click', () => {
    const lang = button.dataset.lang as Lang;
    stopSpeaking();
    void speak(VOICE_SAMPLES[lang], lang);
  });
});

/** In iOS Safari (not yet installed), suggest adding the app to the home screen. */
function setUpInstallHint() {
  const hint = $('install-hint');
  const isIOS =
    /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInstalled =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === '1';
  } catch {
    // Storage unavailable; show the hint.
  }

  hint.hidden = !isIOS || isInstalled || dismissed;
  $('install-hint-close').addEventListener('click', () => {
    hint.hidden = true;
    try {
      localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, '1');
    } catch {
      // Storage unavailable; the hint will reappear next visit.
    }
  });
}

// Only in production: in dev the service worker would serve stale files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => undefined);
  });
}

setUpInstallHint();
onVoicesChanged(populateVoices);
void populateMicrophones();
setStatus('idle');

// Returning visitors already have the models cached, so warm them up right away.
try {
  if (localStorage.getItem(MODELS_CACHED_KEY)) {
    loadModels().catch(() => undefined);
  }
} catch {
  // Storage unavailable; models load on first Start instead.
}
