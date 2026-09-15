import type { FromTts, ToTts } from './messages';
import type { NaturalVoiceId } from './voices';

type ProgressHandler = (loaded: number, total: number) => void;
export type AudioChunk = { samples: Float32Array; sampleRate: number };
type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
type PendingSpeech = Pending<void> & { onChunk: (chunk: AudioChunk) => void };

/** Talks to the natural-voice worker: loads voices once and turns text into audio samples. */
class NaturalVoices {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly ready = new Set<NaturalVoiceId>();
  private readonly loads = new Map<NaturalVoiceId, Promise<void>>();
  private readonly pendingLoads = new Map<NaturalVoiceId, Pending<void>>();
  private readonly progressHandlers = new Map<NaturalVoiceId, ProgressHandler>();
  private readonly pendingAudio = new Map<number, PendingSpeech>();

  isReady(voice: NaturalVoiceId) {
    return this.ready.has(voice);
  }

  load(voice: NaturalVoiceId, onProgress?: ProgressHandler): Promise<void> {
    if (onProgress) {
      this.progressHandlers.set(voice, onProgress);
    }
    let loading = this.loads.get(voice);
    if (!loading) {
      loading = new Promise<void>((resolve, reject) => this.pendingLoads.set(voice, { resolve, reject }));
      this.loads.set(voice, loading);
      // Forget failed loads so a later attempt retries.
      loading.catch(() => this.loads.delete(voice));
      this.send({ type: 'load', voice });
    }
    return loading;
  }

  /** Calls `onChunk` with each sentence's audio as it's generated; resolves after the last one. */
  synthesize(text: string, voice: NaturalVoiceId, onChunk: (chunk: AudioChunk) => void): Promise<void> {
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pendingAudio.set(id, { resolve, reject, onChunk });
      this.send({ type: 'synthesize', id, text, voice });
    });
  }

  private send(message: ToTts) {
    this.ensureWorker().postMessage(message);
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(new URL('./tts-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<FromTts>) => this.handleMessage(event.data));
    worker.addEventListener('error', (event) => this.failAll(event.message || 'The voice engine failed to start.'));
    // ONNX Runtime's WASM files sit next to the page, shared with the voice-activity detector.
    const params = new URLSearchParams(location.search);
    worker.postMessage({
      type: 'init',
      assetBase: new URL('vad/', document.baseURI).href,
      kokoroModel: params.get('kokoroModel') ?? undefined,
      graphOptimization: (params.get('voiceOpt') as 'basic' | 'extended' | 'all' | null) ?? undefined,
    } satisfies ToTts);
    this.worker = worker;
    return worker;
  }

  private handleMessage(message: FromTts) {
    if (message.type === 'progress') {
      this.progressHandlers.get(message.voice)?.(message.loaded, message.total);
    } else if (message.type === 'loaded') {
      this.ready.add(message.voice);
      this.pendingLoads.get(message.voice)?.resolve();
      this.pendingLoads.delete(message.voice);
      this.progressHandlers.delete(message.voice);
    } else if (message.type === 'audio') {
      const pending = this.pendingAudio.get(message.id);
      if (message.samples.length > 0) {
        pending?.onChunk({ samples: message.samples, sampleRate: message.sampleRate });
      }
      if (message.done) {
        pending?.resolve();
        this.pendingAudio.delete(message.id);
      }
    } else if (message.id !== undefined) {
      this.pendingAudio.get(message.id)?.reject(new Error(message.message));
      this.pendingAudio.delete(message.id);
    } else if (message.voice) {
      this.pendingLoads.get(message.voice)?.reject(new Error(message.message));
      this.pendingLoads.delete(message.voice);
      this.progressHandlers.delete(message.voice);
    }
  }

  /** The worker died (e.g. out of memory): fail everything and start fresh next time. */
  private failAll(message: string) {
    const error = new Error(message);
    this.pendingLoads.forEach((pending) => pending.reject(error));
    this.pendingAudio.forEach((pending) => pending.reject(error));
    this.pendingLoads.clear();
    this.pendingAudio.clear();
    this.progressHandlers.clear();
    this.loads.clear();
    this.ready.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

export const naturalVoices = new NaturalVoices();
