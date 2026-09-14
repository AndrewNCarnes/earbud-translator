import { MicVAD } from '@ricky0123/vad-web';

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput');
}

type ListenerOptions = {
  deviceId?: string;
  onSpeechStart: () => void;
  /** 16 kHz mono samples for one phrase. */
  onSpeechEnd: (audio: Float32Array) => void;
  onMisfire: () => void;
};

/** Opens the mic and splits what it hears into phrases, using the Silero voice-activity detector. */
export async function createListener({ deviceId, onSpeechStart, onSpeechEnd, onMisfire }: ListenerOptions) {
  // Absolute URL: vad-web resolves relative paths against its own bundled module, not the page.
  // Basing it on the page keeps it working under a GitHub Pages sub-path too.
  const assetBase = new URL('vad/', document.baseURI).href;
  const vad = await MicVAD.new({
    model: 'v5',
    baseAssetPath: assetBase,
    onnxWASMBasePath: assetBase,
    startOnLoad: false,
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    // How long a pause ends a phrase.
    redemptionMs: 600,
    minSpeechMs: 400,
    preSpeechPadMs: 300,
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire: onMisfire,
  });
  await vad.start();
  return vad;
}
