// Hooks the engine provides back to the core (kept minimal so core stays pure).
export const services = {
  /** current transport playhead in seconds */
  playhead: (): number => 0,
  /** start / stop a macro (the store installs these) */
  runMacro: (_id: string): void => {},
  stopMacro: (_id: string): void => {},
};
