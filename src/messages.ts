export type Lang = 'en' | 'es';

export const OTHER: Record<Lang, Lang> = { en: 'es', es: 'en' };

export type ToWorker =
  | { type: 'load' }
  | { type: 'process'; id: number; audio: Float32Array };

export type FromWorker =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; language: Lang; confidence: number; text: string; translation: string }
  | { type: 'skip'; id: number }
  | { type: 'error'; id?: number; message: string };
