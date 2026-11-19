// Shared with Convex's isolate: do not import Node builtins here.
export const TONES = Object.freeze(['tendre', 'joyeux', 'sobre', 'poetique']);
export const GENDERS = Object.freeze(['girl', 'boy', 'neutral']);
export const RELIGIONS = Object.freeze(['general', 'islam']);

const FIELDS = new Set(['firstName', 'nameArabic', 'gender', 'birthDate', 'religion', 'tone', 'phrases']);
const fail = (field) => { throw new Error(`invalid_brief_${field}`); };
const namePattern = /^[\p{L}\p{M} '\-’]+$/u;
const phrasePattern = /^[\p{L}\p{M}\p{N} .,;:!?'’«»"\-()،؛؟]+$/u;

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
  if (!GENDERS.includes(input.gender)) fail('gender');
  if (input.birthDate !== null && !validDate(input.birthDate)) fail('birthDate');
  if (!RELIGIONS.includes(input.religion) || (paid && input.religion !== 'general')) fail('religion');
  if (!TONES.includes(input.tone)) fail('tone');
  if (!Array.isArray(input.phrases) || input.phrases.length > 3) fail('phrases');
  const phrases = input.phrases.map((value) => {
    if (typeof value !== 'string') fail('phrases');
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 140 || /[\r\n]/u.test(value) || !phrasePattern.test(trimmed) || /(?:https?:|www\.|\b[\p{L}\p{N}-]+\.[\p{L}]{2,}\b)/iu.test(trimmed)) fail('phrases');
    return trimmed;
  });
  return Object.freeze({ firstName, nameArabic, gender: input.gender, birthDate: input.birthDate, religion: input.religion, tone: input.tone, phrases: Object.freeze(phrases), languages: Object.freeze([...languages]) });
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
  return { firstName: intake?.baby?.firstName ?? '', nameArabic: intake?.baby?.nameArabic ?? null, gender: intake?.baby?.gender ?? 'neutral', birthDate: intake?.birthDate ?? null, religion: intake?.context?.religion ?? 'general', tone: 'tendre', phrases: [] };
}
