import { NativeModule, requireNativeModule } from 'expo';

import { LanguageStatus, LiveTranslatorModuleEvents, StartOptions } from './LiveTranslator.types';

declare class LiveTranslatorModule extends NativeModule<LiveTranslatorModuleEvents> {
  /** Asks for microphone and speech permissions. Resolves true if both are granted. */
  requestPermissions(): Promise<boolean>;
  /** Reports whether speech models and translation packs are installed. */
  getLanguageStatus(): Promise<LanguageStatus>;
  /** Downloads missing speech models and shows Apple's translation download sheet. */
  downloadLanguages(): Promise<LanguageStatus>;
  start(options: StartOptions): Promise<void>;
  stop(): Promise<void>;
}

export default requireNativeModule<LiveTranslatorModule>('LiveTranslator');
