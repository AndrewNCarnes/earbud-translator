export type Lang = 'en' | 'es';

export const OTHER: Record<Lang, Lang> = { en: 'es', es: 'en' };

export type ToWorker =
  /** `lowMemory` picks smaller CPU-only model variants (phones, where Safari kills tabs using ~1 GB+). */
  | { type: 'load'; lowMemory: boolean }
  | { type: 'process'; id: number; audio: Float32Array };

export type FromWorker =
  /** Which model is being loaded now; models load one at a time to keep memory down. */
  | { type: 'stage'; label: string }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; language: Lang; confidence: number; text: string; translation: string }
  | { type: 'skip'; id: number }
  | { type: 'error'; id?: number; message: string };
