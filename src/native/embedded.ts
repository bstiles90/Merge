// When the console runs inside the Merge app window, the app loads it with
// ?embedded=1&port=N. Then it connects to its own engine automatically and uses
// the engine for show files (the embedded web view has no browser downloads).
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

export const EMBEDDED = params.get('embedded') === '1';
export const EMBEDDED_PORT = Number(params.get('port') || 18620);
export const EMBEDDED_URL = `ws://127.0.0.1:${EMBEDDED_PORT}`;
