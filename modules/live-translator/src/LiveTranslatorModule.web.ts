import { registerWebModule, NativeModule } from 'expo';

import { LanguageStatus, LiveTranslatorModuleEvents } from './LiveTranslator.types';

const unsupported = () => Promise.reject(new Error('LiveTranslator is only available on iOS.'));

// LiveTranslatorModule is not available on the web platform.
class LiveTranslatorModule extends NativeModule<LiveTranslatorModuleEvents> {
  requestPermissions = (): Promise<boolean> => unsupported();
  getLanguageStatus = (): Promise<LanguageStatus> => unsupported();
  downloadLanguages = (): Promise<LanguageStatus> => unsupported();
  start = (): Promise<void> => unsupported();
  stop = (): Promise<void> => unsupported();
}

export default registerWebModule(LiveTranslatorModule, 'LiveTranslatorModule');
