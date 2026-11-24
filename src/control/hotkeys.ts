// Keyboard hotkeys for user keys. Stream Deck (and Bitfocus Companion, X-keys,
// etc.) can send these as hotkey actions, giving physical buttons with zero
// integration work. F13–F24 are a good choice because nothing else uses them.

import { useConsole } from '../core/store';

export function eventToHotkey(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.code;
  parts.push(k);
  return parts.join('+');
}

let learnCb: ((hotkey: string) => void) | null = null;
export function learnHotkey(cb: (hotkey: string) => void) {
  learnCb = cb;
}
export function cancelLearnHotkey() {
  learnCb = null;
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

export function installHotkeys() {
  const down = (e: KeyboardEvent) => {
    const hk = eventToHotkey(e);
    if (!hk) return;
    if (learnCb) {
      e.preventDefault();
      const cb = learnCb;
      learnCb = null;
      cb(hk === 'Escape' ? '' : hk);
      return;
    }
    if (isTyping(e)) return;
    const s = useConsole.getState();
    const key = s.userKeys.find((k) => k.hotkey === hk);
    if (key) {
      e.preventDefault();
      if (!e.repeat) s.pressKey(key.id);
      return;
    }
    if (hk === 'Space') {
      e.preventDefault();
      s.dispatch({ type: 'transport.toggle', args: {} });
    }
  };
  const up = (e: KeyboardEvent) => {
    const hk = eventToHotkey(e);
    if (!hk) return;
    const s = useConsole.getState();
    // release by base key so modifier release order doesn't strand a momentary key
    for (const key of s.userKeys) {
      if (key.hotkey && (key.hotkey === hk || key.hotkey.split('+').pop() === hk.split('+').pop()) && s.keyStates[key.id]) {
        s.releaseKey(key.id);
      }
    }
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
  };
}
