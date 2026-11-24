import { useEffect, useState, useSyncExternalStore } from 'react';
import { getEngine, startEngine, type Engine } from '../audio/engine';
import { listDevices } from '../audio/devices';
import { useNative } from '../native/bridge';

const engineListeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  engineListeners.forEach((l) => l());
};

export async function bootEngine(): Promise<Engine> {
  const e = await startEngine();
  e.onChange(bump);
  bump();
  return e;
}

export function useEngine(): Engine | null {
  useSyncExternalStore(
    (cb) => {
      engineListeners.add(cb);
      return () => engineListeners.delete(cb);
    },
    () => version,
  );
  return getEngine();
}

export function useEngineInputs() {
  const engine = useEngine();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      listDevices().then((d) => {
        setDevices(d.inputs);
        setOutputs(d.outputs);
      });
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    const off = engine?.onChange(load);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
      off?.();
    };
  }, [engine]);
  const native = useNative();
  if (native.status === 'connected' && native.device) {
    const d = native.device;
    const label = d.virtual ? 'Engine (no interface)' : `Engine: ${d.inputDevice || d.outputDevice || d.deviceType}`;
    return {
      devices: [{ deviceId: 'native', label, kind: 'audioinput', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo],
      outputs: [] as MediaDeviceInfo[],
      channelsFor: () => Math.max(1, d.inputs.length),
      channelName: (_id: string | undefined, i: number) => d.inputs[i] ?? `In ${i + 1}`,
      native: true,
    };
  }
  return {
    devices,
    outputs,
    channelsFor: (id?: string) => (id && engine?.openInputs.get(id)?.channels) || 2,
    channelName: (_id: string | undefined, i: number) => `In ${i + 1}`,
    native: false,
  };
}
