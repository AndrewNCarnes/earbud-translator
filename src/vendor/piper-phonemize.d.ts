export interface PiperPhonemizeModule {
  callMain(args: string[]): void;
}

/** Emscripten build of piper-phonemize (espeak-ng with all language data). Prints one JSON line per input. */
export function createPiperPhonemize(moduleArg?: {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  locateFile?: (file: string) => string;
}): Promise<PiperPhonemizeModule>;
