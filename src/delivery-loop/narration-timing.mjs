// Pure timing and MPEG framing contract, independent of the speech engine.
export function splitNarrationPhrases(text) {
  if (typeof text !== 'string' || !text || text.split('\n').some(line => line && !line.trim())) throw new Error('narration_input_invalid');
  const sections = text.split('\n\n');
  if (sections.some(section => !section || section.split('\n').some(line => !line.trim()))) throw new Error('narration_input_invalid');
  return sections.flatMap((section, s) => section.split('\n').map((phrase, i, lines) => ({
    text: phrase, pauseAfterSeconds: i < lines.length - 1 ? 0.5 : s < sections.length - 1 ? 1 : 0,
  })));
}
export function validPhraseStarts(starts, count = starts?.length) {
  return Array.isArray(starts) && Number.isInteger(count) && count > 0 && starts.length === count && starts[0] === 0
    && starts.every((n, i) => typeof n === 'number' && Number.isFinite(n) && n < 3600 && (i === 0 || n > starts[i - 1]));
}
const invalid = () => { throw new Error('narration_audio_invalid'); };
export function parseMp3(input) {
  if (!Buffer.isBuffer(input)) invalid();
  let offset = 0, end = input.length;
  if (end >= 3 && input.toString('ascii', 0, 3) === 'ID3') {
    if (end < 10 || [...input.subarray(6, 10)].some(n => n & 0x80)) invalid();
    const size = input[6] * 2097152 + input[7] * 16384 + input[8] * 128 + input[9];
    offset = 10 + size + (input[5] & 0x10 ? 10 : 0);
    if (offset > end) invalid();
  }
  if (end - offset >= 128 && input.toString('ascii', end - 128, end - 125) === 'TAG') end -= 128;
  const start = offset;
  let first, frames = 0;
  while (offset < end) {
    if (end - offset < 4) invalid();
    const a = input[offset], b = input[offset + 1], c = input[offset + 2], d = input[offset + 3];
    const version = (b >> 3) & 3, layer = (b >> 1) & 3, bitrateIndex = c >> 4, rateIndex = (c >> 2) & 3;
    if (a !== 255 || (b & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) invalid();
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / sampleRate) + ((c >> 1) & 1);
    const channelMode = d >> 6, samplesPerFrame = version === 3 ? 1152 : 576;
    if (frameLength < 4 || offset + frameLength > end) invalid();
    if (!first) first = { version, sampleRate, channelMode, samplesPerFrame, header: Buffer.from(input.subarray(offset, offset + 4)) };
    else if (version !== first.version || sampleRate !== first.sampleRate || channelMode !== first.channelMode) invalid();
    frames++; offset += frameLength;
  }
  if (!frames || offset !== end) invalid();
  return { ...first, frames, duration: frames * first.samplesPerFrame / first.sampleRate, audio: input.subarray(start, end) };
}
export function concatenateNarration(segments, phrases) {
  if (!Array.isArray(segments) || !segments.length || segments.length !== phrases.length) invalid();
  const parsed = segments.map(parseMp3), first = parsed[0];
  if (parsed.some(p => p.version !== first.version || p.sampleRate !== first.sampleRate || p.channelMode !== first.channelMode)) invalid();
  const header = Buffer.from(first.header); header[1] |= 1; header[2] &= ~2;
  const index = header[2] >> 4, rates = first.version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const silent = Buffer.alloc(Math.floor((first.version === 3 ? 144 : 72) * rates[index] * 1000 / first.sampleRate)); header.copy(silent);
  const parts = [], phraseStarts = []; let totalFrames = 0;
  const frameDuration = first.samplesPerFrame / first.sampleRate;
  for (let i = 0; i < parsed.length; i++) {
    phraseStarts.push(Math.round(totalFrames * frameDuration * 1000) / 1000);
    parts.push(parsed[i].audio); totalFrames += parsed[i].frames;
    const pauses = Math.round(phrases[i].pauseAfterSeconds / frameDuration);
    for (let j = 0; j < pauses; j++) parts.push(silent);
    totalFrames += pauses;
  }
  return { audio: Buffer.concat(parts), phraseStarts };
}
export async function narratePhrases({ text, language, synthesize, concurrency = 4 }) {
  const phrases = splitNarrationPhrases(text);
  if (typeof synthesize !== 'function' || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('narration_input_invalid');
  const segments = new Array(phrases.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, phrases.length) }, async () => {
    for (;;) { const i = next++; if (i >= phrases.length) return; segments[i] = await synthesize({ text: phrases[i].text, language }); }
  }));
  return concatenateNarration(segments, phrases);
}
