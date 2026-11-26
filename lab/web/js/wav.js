// WAV reading for the Listening Room: header via a small Range request, then any frame range.
// Decoding ourselves keeps playback independent of the browser's codecs and lets long
// recordings be played in windows (bounded memory) while staying sample-aligned.

export async function wavHeader(url) {
  let r = await fetch(url, { headers: { Range: 'bytes=0-131071' } });
  if (!r.ok) throw new Error(`Audio not available (${r.status})`);
  let buf = await r.arrayBuffer();
  let info = parseHeader(new DataView(buf));
  if (!info.dataOffset && info.needMore) {
    r = await fetch(url, { headers: { Range: `bytes=0-${info.needMore + 65535}` } });
    info = parseHeader(new DataView(await r.arrayBuffer()));
  }
  if (!info.dataOffset) throw new Error('Not a WAV file this player can read');
  info.url = url;
  return info;
}

function str4(dv, o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }

function parseHeader(dv) {
  const riff = str4(dv, 0);
  if (riff !== 'RIFF' && riff !== 'RF64') throw new Error('Not a WAV file');
  let o = 12, fmt = null, dataOffset = 0, dataSize = 0, ds64 = null;
  while (o + 8 <= dv.byteLength) {
    const id = str4(dv, o); let size = dv.getUint32(o + 4, true);
    if (id === 'ds64') ds64 = { data: Number(dv.getBigUint64(o + 16, true)) };
    if (id === 'fmt ') {
      let tag = dv.getUint16(o + 8, true);
      const ch = dv.getUint16(o + 10, true), sr = dv.getUint32(o + 12, true), bits = dv.getUint16(o + 22, true);
      if (tag === 0xfffe && size >= 40) tag = dv.getUint16(o + 32, true);
      fmt = { tag, channels: ch, sampleRate: sr, bits, blockAlign: dv.getUint16(o + 20, true) };
    }
    if (id === 'data') {
      dataOffset = o + 8;
      dataSize = size === 0xffffffff && ds64 ? ds64.data : size;
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!dataOffset) return { needMore: o };
  if (!fmt) throw new Error('WAV file without a format chunk');
  if (!((fmt.tag === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.tag === 3 && fmt.bits === 32)))
    throw new Error(`Unsupported WAV encoding (format ${fmt.tag}, ${fmt.bits}-bit)`);
  return { ...fmt, dataOffset, frames: Math.floor(dataSize / fmt.blockAlign), duration: Math.floor(dataSize / fmt.blockAlign) / fmt.sampleRate };
}

// Read frames [f0, f0+n) into an AudioBuffer of the file's own sample rate.
export async function wavFrames(ctx, info, f0, n, signal) {
  f0 = Math.max(0, Math.min(f0, info.frames)); n = Math.max(1, Math.min(n, info.frames - f0));
  const a = info.dataOffset + f0 * info.blockAlign, b = a + n * info.blockAlign - 1;
  const r = await fetch(info.url, { headers: { Range: `bytes=${a}-${b}` }, signal });
  if (!r.ok) throw new Error(`Audio not available (${r.status})`);
  const bytes = await r.arrayBuffer();
  const frames = Math.floor(bytes.byteLength / info.blockAlign);
  const ab = ctx.createBuffer(info.channels, Math.max(1, frames), info.sampleRate);
  const dv = new DataView(bytes), ch = info.channels, bps = info.bits / 8;
  const outs = []; for (let c = 0; c < ch; c++) outs.push(ab.getChannelData(c));
  if (info.tag === 3) {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < ch; c++, p += 4) outs[c][i] = dv.getFloat32(p, true);
  } else if (info.bits === 16) {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < ch; c++, p += 2) outs[c][i] = dv.getInt16(p, true) / 32768;
  } else if (info.bits === 24) {
    const u8 = new Uint8Array(bytes);
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < ch; c++, p += 3) {
      let v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      outs[c][i] = v / 8388608;
    }
  } else {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < ch; c++, p += bps) outs[c][i] = dv.getInt32(p, true) / 2147483648;
  }
  return ab;
}
