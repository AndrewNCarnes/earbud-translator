import './style.css';

import type { MicVAD } from '@ricky0123/vad-web';

import { createListener, listMicrophones } from './audio';
import { OTHER, type FromWorker, type Lang, type ToWorker } from './messages';
import { translateOnline } from './online-translate';
import {
  getPreferredVoice,
  onVoicesChanged,
  setPreferredVoice,
  speak,
  stopSpeaking,
  unlockSpeech,
  voicesFor,
} from './speech';
import { WebSpeechListener, isWebSpeechSupported } from './webspeech';

/**
 * - `ai`: Whisper + Opus-MT on-device via Transformers.js 4; detects the language automatically.
 *   Known to crash iPhone Safari while loading (an open Transformers.js bug).
 * - `ai-legacy`: the same on Transformers.js 2.15.1, an experimental workaround for that crash.
 * - `webspeech`: the browser's built-in speech recognition + MyMemory online translation; the user picks the language.
 * - `auto`: `webspeech` on iPhone, `ai` everywhere else.
 */
type EngineChoice = 'auto' | 'ai' | 'ai-legacy' | 'webspeech';
type Engine = Exclude<EngineChoice, 'auto'>;
type AiEngine = Exclude<Engine, 'webspeech'>;

const ENGINE_CHOICES: EngineChoice[] = ['auto', 'ai', 'ai-legacy', 'webspeech'];
const ENGINE_NAMES: Record<Engine, string> = {
  ai: 'on-device AI',
  'ai-legacy': 'on-device AI (old library)',
  webspeech: 'Safari speech + online translation',
};
const ENGINE_NOTES: Record<Engine, string> = {
  ai: 'Private and detects the language for you. Downloads a few hundred MB once. Currently crashes Safari on iPhone.',
  'ai-legacy':
    'Experimental: an older version of the AI library that might avoid the iPhone crash. Downloads about 320 MB once.',
  webspeech: "No download, but needs internet. Choose which language you're hearing with the buttons above.",
};
const EMPTY_TEXT: Record<'ai' | 'webspeech', string> = {
  ai: 'Tap Start, then talk or play some English or Spanish. The first start downloads a few hundred MB of AI models, so use Wi-Fi.',
  webspeech: "Choose the language you're hearing, tap Start, and let them talk.",
};

const FLAGS: Record<Lang, string> = { en: '🇺🇸', es: '🇪🇸' };
const LANGS: Lang[] = ['en', 'es'];
const VOICE_SAMPLES: Record<Lang, string> = {
  en: 'Hi! This is how your translations will sound.',
  es: '¡Hola! Así sonarán tus traducciones.',
};

const MODELS_CACHED_KEY = 'airpod-translator:models-cached';
const INSTALL_HINT_DISMISSED_KEY = 'airpod-translator:install-hint-dismissed';
/** Set while models load and cleared when loading ends, so a leftover value means the tab crashed mid-load. */
const LOAD_STAGE_KEY = 'airpod-translator:load-stage';
const ENGINE_KEY = 'airpod-translator:engine';
const LISTEN_LANGUAGE_KEY = 'airpod-translator:listen-language';
const EMAIL_KEY = 'airpod-translator:translation-email';

/** Ignore the mic briefly after speaking so the tail of the voice isn't picked up. */
const ECHO_TAIL_MS = 300;

const IS_IOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const URL_PARAMS = new URLSearchParams(location.search);
/** iPhone Safari kills tabs that use much more than ~1 GB. `?lowmem` forces this mode for testing on a PC. */
const IS_LOW_MEMORY = IS_IOS || URL_PARAMS.has('lowmem');

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
const micField = $('mic-field');
const micSelect = $<HTMLSelectElement>('mic');
const direction = $('direction');
const listenButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-listen]')];
const engineSelect = $<HTMLSelectElement>('engine');
const engineNote = $('engine-note');
const emailField = $('email-field');
const emailInput = $<HTMLInputElement>('email');
const errorBox = $('error');
const list = $('entries');
const empty = $('empty');
const mainButton = $<HTMLButtonElement>('main-button');
const voiceSelects: Record<Lang, HTMLSelectElement> = {
  en: $<HTMLSelectElement>('voice-en'),
  es: $<HTMLSelectElement>('voice-es'),
};

let worker: Worker | null = null;
let workerEngine: AiEngine | null = null;
let modelsReady: Promise<void> | null = null;
let listener: MicVAD | null = null;
let webSpeech: WebSpeechListener | null = null;
let running = false;
let speaking = false;
let ignoreUntil = 0;
let hearingIgnored = false;
let pending = 0;
let nextId = 0;
let speechChain: Promise<void> = Promise.resolve();
let wakeLock: WakeLockSentinel | null = null;
let listenLanguage: Lang = 'es';

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage unavailable (e.g. private browsing); the setting just isn't remembered.
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const modelsCachedKey = (engine: AiEngine) => (engine === 'ai' ? MODELS_CACHED_KEY : `${MODELS_CACHED_KEY}:legacy`);

function engineChoice(): EngineChoice {
  return engineSelect.value as EngineChoice;
}

function resolveEngine(choice: EngineChoice): Engine {
  if (choice !== 'auto') {
    return choice;
  }
  return IS_IOS && isWebSpeechSupported() ? 'webspeech' : 'ai';
}

const currentEngine = () => resolveEngine(engineChoice());

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

function createWorker(engine: AiEngine): Worker {
  // Vite only bundles workers written literally as `new Worker(new URL(...), ...)`.
  const created =
    engine === 'ai'
      ? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./worker-legacy.ts', import.meta.url), { type: 'module' });
  created.addEventListener('message', handleWorkerResult);
  return created;
}

function workerFor(engine: AiEngine): Worker {
  if (!worker || workerEngine !== engine) {
    worker?.terminate();
    worker = createWorker(engine);
    workerEngine = engine;
    modelsReady = null;
  }
  return worker;
}

function send(message: ToWorker, transfer: Transferable[] = []) {
  worker?.postMessage(message, transfer);
}

function loadModels(engine: AiEngine): Promise<void> {
  const target = workerFor(engine);
  modelsReady ??= new Promise<void>((resolve, reject) => {
    let stage = 'models';
    const cleanup = () => {
      target.removeEventListener('message', onMessage);
      target.removeEventListener('error', onWorkerError);
      progress.hidden = true;
      writeSetting(LOAD_STAGE_KEY, null);
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
      if (message.type === 'stage') {
        stage = message.label;
        writeSetting(LOAD_STAGE_KEY, stage);
        progress.hidden = false;
        progressBar.style.width = '0%';
        progressText.textContent = `Loading ${stage}…`;
      } else if (message.type === 'progress' && message.total > 0) {
        progress.hidden = false;
        progressBar.style.width = `${Math.min(100, (message.loaded / message.total) * 100)}%`;
        progressText.textContent = `Downloading ${stage}: ${formatMB(message.loaded)} of ${formatMB(message.total)} (one time only)`;
      } else if (message.type === 'ready') {
        cleanup();
        writeSetting(modelsCachedKey(engine), '1');
        resolve();
      } else if (message.type === 'error' && message.id === undefined) {
        fail(message.message);
      }
    };
    target.addEventListener('message', onMessage);
    target.addEventListener('error', onWorkerError);
    target.postMessage({ type: 'load', lowMemory: IS_LOW_MEMORY } satisfies ToWorker);
  });
  return modelsReady;
}

function handleWorkerResult(event: MessageEvent<FromWorker>) {
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
}

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
    webSpeech?.pause();
    refreshStatus();
    await speak(text, lang);
    ignoreUntil = performance.now() + ECHO_TAIL_MS;
    speaking = false;
    // Resume only if nothing else started speaking during the echo tail.
    setTimeout(() => {
      if (!speaking) {
        webSpeech?.resume();
      }
    }, ECHO_TAIL_MS);
    refreshStatus();
  });
}

async function translatePhrase(text: string, language: Lang) {
  pending += 1;
  refreshStatus();
  try {
    const email = emailInput.value.trim() && emailInput.checkValidity() ? emailInput.value.trim() : undefined;
    const translation = await translateOnline(text, language, OTHER[language], email);
    if (running) {
      addEntry(language, text, translation);
      enqueueSpeech(translation, OTHER[language]);
    }
  } catch (error) {
    showError(errorText(error));
  } finally {
    pending = Math.max(0, pending - 1);
    refreshStatus();
  }
}

function startWebSpeech() {
  webSpeech ??= new WebSpeechListener({
    getLanguage: () => listenLanguage,
    onHearing: () => {
      if (!speaking && pending === 0) {
        setStatus('hearing');
      }
    },
    onPhrase: (text, language) => void translatePhrase(text, language),
    onFatalError: (message) => {
      showError(message);
      void stop();
    },
  });
  webSpeech.start();
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
  const engine = currentEngine();
  running = true;
  mainButton.disabled = true;
  engineSelect.disabled = true;

  try {
    if (engine === 'webspeech') {
      // Start recognition before any await so it's still inside the tap, which iOS requires.
      startWebSpeech();
      refreshStatus();
      await requestWakeLock();
    } else {
      setStatus('loading');
      await Promise.all([loadModels(engine), requestWakeLock()]);
      await startListening();
      // Device labels are only visible after mic permission is granted.
      await populateMicrophones();
    }
    mainButton.textContent = 'Stop';
    mainButton.classList.add('stop');
    refreshStatus();
  } catch (error) {
    await stop();
    showError(errorText(error));
  } finally {
    mainButton.disabled = false;
  }
}

async function stop() {
  running = false;
  speaking = false;
  pending = 0;
  stopSpeaking();
  webSpeech?.stop();
  await listener?.destroy();
  listener = null;
  await wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  mainButton.textContent = 'Start';
  mainButton.classList.remove('stop');
  engineSelect.disabled = false;
  refreshStatus();
}

function renderEngine() {
  const choice = engineChoice();
  const engine = resolveEngine(choice);
  const usesWebSpeech = engine === 'webspeech';
  const prefix = choice === 'auto' ? `Automatic: using ${ENGINE_NAMES[engine]} here. ` : '';

  engineNote.textContent = prefix + ENGINE_NOTES[engine];
  direction.hidden = !usesWebSpeech;
  emailField.hidden = !usesWebSpeech;
  micField.hidden = usesWebSpeech;
  empty.textContent = EMPTY_TEXT[usesWebSpeech ? 'webspeech' : 'ai'];
}

function renderDirection() {
  for (const button of listenButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.listen === listenLanguage));
  }
}

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

/** In iOS Safari (not yet installed), suggest adding the app to the home screen. */
function setUpInstallHint() {
  const hint = $('install-hint');
  const isInstalled =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia('(display-mode: standalone)').matches;

  hint.hidden = !IS_IOS || isInstalled || readSetting(INSTALL_HINT_DISMISSED_KEY) === '1';
  $('install-hint-close').addEventListener('click', () => {
    hint.hidden = true;
    writeSetting(INSTALL_HINT_DISMISSED_KEY, '1');
  });
}

mainButton.addEventListener('click', () => {
  void (running ? stop() : start());
});

micSelect.addEventListener('change', async () => {
  if (!running || !listener) {
    return;
  }
  await listener.destroy();
  await startListening().catch((error) => showError(errorText(error)));
});

engineSelect.addEventListener('change', () => {
  writeSetting(ENGINE_KEY, engineChoice());
  renderEngine();
});

for (const button of listenButtons) {
  button.addEventListener('click', () => {
    listenLanguage = button.dataset.listen as Lang;
    writeSetting(LISTEN_LANGUAGE_KEY, listenLanguage);
    renderDirection();
    webSpeech?.restart();
  });
}

emailInput.addEventListener('change', () => {
  writeSetting(EMAIL_KEY, emailInput.value.trim() || null);
});

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

document.addEventListener('visibilitychange', () => {
  if (!running) {
    return;
  }
  if (document.visibilityState === 'visible') {
    // iOS drops the wake lock whenever the page is hidden.
    void requestWakeLock();
    webSpeech?.resume();
  } else {
    // Recognition left running in a hidden tab can crash iOS Safari.
    webSpeech?.pause();
  }
});

navigator.mediaDevices?.addEventListener('devicechange', () => {
  void populateMicrophones();
});

// Only in production: in dev the service worker would serve stale files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => undefined);
  });
}

// Restore settings. `?engine=` overrides the saved engine without saving it (handy for testing).
const urlEngine = URL_PARAMS.get('engine') as EngineChoice | null;
const savedEngine = readSetting(ENGINE_KEY) as EngineChoice | null;
engineSelect.value = [urlEngine, savedEngine].find((choice) => choice && ENGINE_CHOICES.includes(choice)) ?? 'auto';
listenLanguage = readSetting(LISTEN_LANGUAGE_KEY) === 'en' ? 'en' : 'es';
emailInput.value = readSetting(EMAIL_KEY) ?? '';

setUpInstallHint();
renderEngine();
renderDirection();
onVoicesChanged(populateVoices);
void populateMicrophones();
setStatus('idle');

// A leftover load stage means the tab crashed while loading (usually out of memory). Say so, and don't
// auto-load again, or Safari's automatic reload would crash straight back into the same spot.
const crashedWhileLoading = readSetting(LOAD_STAGE_KEY);
writeSetting(LOAD_STAGE_KEY, null);

if (crashedWhileLoading) {
  const advice = IS_IOS
    ? ' On iPhone, open Settings below and choose “Safari speech + online translation”.'
    : ' Close other tabs and apps, then tap Start again.';
  showError(`Last time, the page stopped while loading the ${crashedWhileLoading}, most likely out of memory.${advice}`);
} else {
  // Returning visitors already have the models cached, so warm them up right away.
  const engine = currentEngine();
  if (engine !== 'webspeech' && readSetting(modelsCachedKey(engine))) {
    loadModels(engine).catch(() => undefined);
  }
}
