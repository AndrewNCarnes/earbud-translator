@AGENTS.md

# AirPod Translator

iPhone app: listens for English or Spanish, translates on-device to the other language, and speaks it through AirPods.

## Stack
- Expo SDK 57 (React Native + TypeScript), iOS only, deployment target iOS 26.
- Native work lives in the local Expo module `modules/live-translator` (Swift):
  - `TranslatorEngine.swift`: pipeline. Mic → two `SpeechAnalyzer` lanes (en-US, es-ES) → `UtteranceResolver`/`LanguagePicker` → `Translator` → `Speaker`.
  - `AudioRouter.swift`: `phone` mode (iPhone mic in, AirPods A2DP out) or `airpods` mode (HFP mic).
  - `AudioTap.swift`: converts mic buffers to the analyzer format and mutes input while speaking (echo guard).
  - `Translator.swift`: Translation framework. Headless sessions need installed packs, and `TranslationDownloadView` triggers the download sheet.
- JS: `App.tsx` (UI) and `src/useTranslator.ts` (hook over module events). The event/type contract is in `modules/live-translator/src/LiveTranslator.types.ts` and must stay in sync with the Swift `emit` calls.

## Development is Windows-only (no Mac)
- Swift can't be compiled locally. The EAS cloud build is the compile check: `eas build --profile development --platform ios`.
- JS-only changes: `npx expo start --tunnel` with the installed dev client, no rebuild needed.
- Swift or `app.json` changes: new EAS dev build.
- Local checks before building: `npx tsc --noEmit` and `npx expo-doctor`.
- Speech/Translation only work on a real iPhone (iOS 26+), not the simulator.
