/** Minimal .tar.gz reader for the simulator: small text files only (package.json, chaos.json). */
import { gunzipSync } from 'node:zlib';

export function readTarGz(buf: Buffer, maxFileBytes = 256 * 1024): Map<string, string> {
  const files = new Map<string, string>();
  let data: Buffer;
  try {
    data = gunzipSync(buf);
  } catch {
    return files;
  }
  for (let off = 0; off + 512 <= data.length; ) {
    const header = data.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const body = data.subarray(off + 512, off + 512 + size);
    if ((type === '0' || type === '\0') && size <= maxFileBytes) files.set((prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ''), body.toString('utf8'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
