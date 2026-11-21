// A bounded, uncompressed ZIP works without Node dependencies.
// Files use fixed first-party names; no user-provided paths or timestamps.
const encoder = new TextEncoder();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function header(length, fields) {
  const bytes = new Uint8Array(length); const view = new DataView(bytes.buffer);
  for (const [offset, value, size] of fields) size === 2 ? view.setUint16(offset, value, true) : view.setUint32(offset, value, true);
  return bytes;
}
export function pageArchive(content, audioBytes) {
  let html = content.contentHtml.replace(/<!--delivery-loop-draft:start-->[\s\S]*?<!--delivery-loop-draft:end-->/g, "");
  const controls = content.audio.map(f => `<audio controls src="audio-${f.language}.mp3"></audio>`).join("\n");
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, controls + "</body>") : html + controls;
  const files = [{ name: "annonce.html", bytes: encoder.encode(html) }, { name: "texte.txt", bytes: encoder.encode(content.text) },
    ...content.audio.map((file, i) => ({ name: `audio-${file.language}.mp3`, bytes: audioBytes[i] }))];
  const local = [], central = []; let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name); const crc = crc32(file.bytes); const size = file.bytes.byteLength;
    const first = header(30, [[0, 0x04034b50, 4], [4, 20, 2], [12, 33, 2], [14, crc, 4], [18, size, 4], [22, size, 4], [26, name.length, 2]]);
    const second = header(46, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [14, 33, 2], [16, crc, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [42, offset, 4]]);
    local.push(first, name, file.bytes); central.push(second, name);
    offset += first.length + name.length + size; centralSize += second.length + name.length;
  }
  const end = header(22, [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, centralSize, 4], [16, offset, 4]]);
  const result = new Uint8Array(offset + centralSize + end.length); let cursor = 0;
  for (const part of [...local, ...central, end]) { result.set(part, cursor); cursor += part.length; }
  return result;
}
