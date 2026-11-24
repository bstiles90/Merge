// Audio interface handling. In the browser every interface the OS exposes is
// reachable here – including Dante Virtual Soundcard / Dante-enabled interfaces
// and the Waves SoundGrid driver, because they present as ordinary CoreAudio /
// WASAPI devices. A native build replaces this with ASIO/CoreAudio direct I/O.

export interface OpenInput {
  deviceId: string;
  label: string;
  channels: number;
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
  splitter: ChannelSplitterNode;
}

export async function listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
  };
}

export async function openInput(ctx: AudioContext, deviceId: string): Promise<OpenInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
      // ask for as many channels as the interface has (Dante VSC can expose 64)
      channelCount: { ideal: 64 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: ctx.sampleRate,
    } as MediaTrackConstraints,
  });
  const track = stream.getAudioTracks()[0];
  const node = ctx.createMediaStreamSource(stream);
  const reported = (track.getSettings() as MediaTrackSettings & { channelCount?: number }).channelCount;
  const channels = Math.max(1, reported ?? node.channelCount ?? 2);
  node.channelCountMode = 'explicit';
  node.channelCount = channels;
  node.channelInterpretation = 'discrete';
  const splitter = ctx.createChannelSplitter(channels);
  node.connect(splitter);
  return { deviceId, label: track.label || deviceId, channels, stream, node, splitter };
}
