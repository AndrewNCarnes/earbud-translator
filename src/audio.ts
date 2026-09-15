import { MicVAD } from '@ricky0123/vad-web';

export type MicrophoneInUse = { id: string; label: string };

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

/**
 * Opens the mic and splits what it hears into phrases, using the Silero voice-activity detector.
 * Also reports which microphone the browser actually opened, which can differ from the one requested.
 */
export async function createListener({
  deviceId,
  onSpeechStart,
  onSpeechEnd,
  onMisfire,
}: ListenerOptions): Promise<{ vad: MicVAD; microphone: MicrophoneInUse | null }> {
  // Absolute URL: vad-web resolves relative paths against its own bundled module, not the page.
  // Basing it on the page keeps it working under a GitHub Pages sub-path too.
  const assetBase = new URL('vad/', document.baseURI).href;
  let stream: MediaStream | undefined;

  const vad = await MicVAD.new({
    model: 'v5',
    baseAssetPath: assetBase,
    onnxWASMBasePath: assetBase,
    startOnLoad: false,
    getStream: async () => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      return stream;
    },
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

  const track = stream?.getAudioTracks()[0];
  return { vad, microphone: track ? { id: track.getSettings().deviceId ?? '', label: track.label } : null };
}
