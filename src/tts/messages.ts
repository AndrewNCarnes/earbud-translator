import type { NaturalVoiceId } from './voices';

export type ToTts =
  /**
   * `assetBase`: absolute URL of the folder holding ONNX Runtime's WASM files.
   * `kokoroModel` / `graphOptimization`: testing overrides (from `?kokoroModel=` / `?voiceOpt=`).
   */
  | { type: 'init'; assetBase: string; kokoroModel?: string; graphOptimization?: 'basic' | 'extended' | 'all' }
  | { type: 'load'; voice: NaturalVoiceId }
  | { type: 'synthesize'; id: number; text: string; voice: NaturalVoiceId };

export type FromTts =
  | { type: 'progress'; voice: NaturalVoiceId; loaded: number; total: number }
  | { type: 'loaded'; voice: NaturalVoiceId }
  /** One sentence of audio, sent as soon as it's ready; `done` marks the last one for this request. */
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number; done: boolean }
  | { type: 'error'; id?: number; voice?: NaturalVoiceId; message: string };
