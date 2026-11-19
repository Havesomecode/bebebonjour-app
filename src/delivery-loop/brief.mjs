// Shared with Convex's isolate: do not import Node builtins here.
export const TONES = Object.freeze(['tendre', 'joyeux', 'sobre', 'poetique']);
export const GENDERS = Object.freeze(['girl', 'boy', 'neutral']);
export const RELIGIONS = Object.freeze(['general', 'islam']);

const FIELDS = new Set(['firstName', 'nameArabic', 'nameMeaning', 'gender', 'birthDate', 'religion', 'tone', 'phrases']);
const fail = (field) => { throw new Error(`invalid_brief_${field}`); };
const namePattern = /^[\p{L}\p{M} '\-’]+$/u;
const phrasePattern = /^[\p{L}\p{M}\p{N} .,;:!?'’«»"\-()،؛؟]+$/u;
const meaningPattern = /^[\p{L}\p{M}\p{N} .,;:!?'’«»"\-()،؛؟…]+$/u;
const urlPattern = /(?:https?:|www\.|\b[\p{L}\p{N}-]+\.[\p{L}]{2,}\b)/iu;
const normalizeMeaning = (value) => value.trim().replace(/\s+/gu, ' ');
const latin = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const arabic = (value) => value.replace(/[\p{M}\u0640]/gu, '');

function containsName(value, firstName, nameArabic) {
  const escaped = latin(firstName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const latinName = !/\p{Script=Arabic}/u.test(firstName) && new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(latin(value));
  const arabicName = nameArabic && arabic(nameArabic);
  return latinName || Boolean(arabicName && arabic(value).includes(arabicName));
}

function name(value, field) {
  if (typeof value !== 'string') fail(field);
  const normalized = value.trim();
  if (!normalized || normalized.length > 60 || !namePattern.test(normalized)) fail(field);
  return normalized;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateBrief(input, { languages, paid } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('input');
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) fail(key);
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 2 || new Set(languages).size !== languages.length || languages.some((item) => !['fr', 'ar'].includes(item))) fail('languages');
  const firstName = name(input.firstName, 'firstName');
  const nameArabic = input.nameArabic === null ? null : name(input.nameArabic, 'nameArabic');
  if (input.nameMeaning != null && typeof input.nameMeaning !== 'string') fail('nameMeaning');
  const nameMeaning = input.nameMeaning == null ? null : normalizeMeaning(input.nameMeaning) || null;
  if (nameMeaning && (nameMeaning.length > 400 || !meaningPattern.test(nameMeaning) || urlPattern.test(nameMeaning) || containsName(nameMeaning, firstName, nameArabic))) fail('nameMeaning');
  if (!GENDERS.includes(input.gender)) fail('gender');
  if (input.birthDate !== null && !validDate(input.birthDate)) fail('birthDate');
  if (!RELIGIONS.includes(input.religion) || (paid && input.religion !== 'general')) fail('religion');
  if (!TONES.includes(input.tone)) fail('tone');
  if (!Array.isArray(input.phrases) || input.phrases.length > 3) fail('phrases');
  const phrases = input.phrases.map((value) => {
    if (typeof value !== 'string') fail('phrases');
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 140 || /[\r\n]/u.test(value) || !phrasePattern.test(trimmed) || urlPattern.test(trimmed)) fail('phrases');
    return trimmed;
  });
  return Object.freeze({ firstName, nameArabic, nameMeaning, gender: input.gender, birthDate: input.birthDate, religion: input.religion, tone: input.tone, phrases: Object.freeze(phrases), languages: Object.freeze([...languages]) });
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

export async function briefDigest(brief) {
  const bytes = new TextEncoder().encode(JSON.stringify(sorted(brief)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function suggestBrief(intake) {
  const marker = 'Sens du prénom : ';
  const request = typeof intake?.request === 'string' ? intake.request : '';
  const position = request.lastIndexOf(marker);
  const nameMeaning = position < 0 ? null : normalizeMeaning(request.slice(position + marker.length)).slice(0, 400).trim() || null;
  return { firstName: intake?.baby?.firstName ?? '', nameArabic: intake?.baby?.nameArabic ?? null, gender: intake?.baby?.gender ?? 'neutral', birthDate: intake?.birthDate ?? null, religion: intake?.context?.religion ?? 'general', tone: 'tendre', phrases: [], nameMeaning };
}
