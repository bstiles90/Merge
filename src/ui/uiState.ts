// View state for this machine (not part of the show): the channel settings drawer and the
// screen layout (one bank, two banks, or one bank with the channel panel pinned open).
import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** auto: one bank on a laptop-size window; one bank + pinned channel panel on a big screen */
export type LayoutPref = 'auto' | 'single' | 'split' | 'pinned';
export type LayoutMode = 'single' | 'split' | 'pinned';

interface UiState {
  /** the right-side drawer with the selected strip's settings */
  drawerOpen: boolean;
  /** user key being edited in the drawer (instead of the strip settings) */
  editKey: string | null;
  layout: LayoutPref;
  /** the layout in effect right now (auto resolved against the window width) */
  mode: LayoutMode;
}

const loadLayout = (): LayoutPref => {
  try {
    const v = localStorage.getItem('merge.layout');
    return v === 'single' || v === 'split' || v === 'pinned' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
};

/** Window wide enough for 16 faders plus a pinned channel panel (e.g. a 27" display at 2560). */
export const BIG_SCREEN_WIDTH = 1900;

export const resolveLayout = (pref: LayoutPref, width: number): LayoutMode => (pref === 'auto' ? (width >= BIG_SCREEN_WIDTH ? 'pinned' : 'single') : pref);

export const useUi = create<UiState>(() => {
  const layout = loadLayout();
  return { drawerOpen: false, editKey: null, layout, mode: resolveLayout(layout, typeof window === 'undefined' ? 1500 : window.innerWidth) };
});

export const openDrawer = () => useUi.setState({ drawerOpen: true, editKey: null });
export const closeDrawer = () => useUi.setState({ drawerOpen: false, editKey: null });
export const editUserKey = (id: string) => useUi.setState({ drawerOpen: true, editKey: id });
export function setLayout(layout: LayoutPref) {
  try {
    localStorage.setItem('merge.layout', layout);
  } catch {
    /* storage unavailable */
  }
  useUi.setState({ layout, mode: resolveLayout(layout, window.innerWidth) });
}

/** Keep the effective layout in step with the window size (moving between screens, resizing). */
export function useLayoutMode(): LayoutMode {
  const mode = useUi((s) => s.mode);
  const [, force] = useState(0);
  useEffect(() => {
    const onResize = () => {
      const { layout, mode: cur } = useUi.getState();
      const next = resolveLayout(layout, window.innerWidth);
      if (next !== cur) useUi.setState({ mode: next });
      force((n) => n + 1);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mode;
}
