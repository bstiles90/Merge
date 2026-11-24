import type { ConsoleState, MixSnapshot, Scene } from './types';

export function takeSnapshot(s: ConsoleState): MixSnapshot {
  return structuredClone({
    channels: s.channels,
    buses: s.buses,
    main: s.main,
    dcas: s.dcas,
    muteGroups: s.muteGroups,
  });
}

/**
 * Recall a scene, honouring the global recall scope and per-strip recall safes.
 * Things that are about routing/identity of the live session (record arm, solo,
 * playback mode) are never recalled.
 */
export function applyScene(s: ConsoleState, scene: Scene): ConsoleState {
  const snap = structuredClone(scene.snapshot);
  const scope = s.sceneScope;
  let next: ConsoleState = { ...s, currentScene: scene.id };

  if (scope.channels) {
    next.channels = s.channels.map((cur) => {
      const saved = snap.channels.find((c) => c.id === cur.id);
      if (!saved || cur.recallSafe) return cur;
      return {
        ...saved,
        solo: cur.solo,
        recArm: cur.recArm,
        inputMode: cur.inputMode,
        recallSafe: cur.recallSafe,
        source: cur.source,
      };
    });
  }
  if (scope.buses) {
    next.buses = s.buses.map((cur) => {
      const saved = snap.buses.find((b) => b.id === cur.id);
      if (!saved || cur.recallSafe) return cur;
      return { ...saved, solo: cur.solo, recallSafe: cur.recallSafe };
    });
  }
  if (scope.main) next.main = snap.main;
  if (scope.dcas) next.dcas = snap.dcas;
  if (scope.muteGroups) next.muteGroups = snap.muteGroups;
  return next;
}
