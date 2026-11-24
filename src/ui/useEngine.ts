import { useEffect, useState, useSyncExternalStore } from 'react';
import { getEngine, startEngine, type Engine } from '../audio/engine';
import { listDevices } from '../audio/devices';

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
  return {
    devices,
    outputs,
    channelsFor: (id?: string) => (id && engine?.openInputs.get(id)?.channels) || 2,
  };
}
