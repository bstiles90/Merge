// View state for this machine (not part of the show): the channel settings drawer.
import { create } from 'zustand';

interface UiState {
  /** the right-side drawer with the selected strip's settings */
  drawerOpen: boolean;
  /** user key being edited in the drawer (instead of the strip settings) */
  editKey: string | null;
}

export const useUi = create<UiState>(() => ({ drawerOpen: false, editKey: null }));

export const openDrawer = () => useUi.setState({ drawerOpen: true, editKey: null });
export const closeDrawer = () => useUi.setState({ drawerOpen: false, editKey: null });
export const editUserKey = (id: string) => useUi.setState({ drawerOpen: true, editKey: id });
