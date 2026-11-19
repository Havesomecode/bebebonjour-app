import { normalizeArabicName } from "../../scripts/lib/name-resolution.mjs";
import { forbiddenNameForms } from "./name-reference.mjs";

const latin = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fields = ["introLines", "blessingLines", "meaningLines", "revealLines", "introNarration", "blessingNarration"];

export function findNameLeak(composition, brief) {
  const forms = forbiddenNameForms(brief);
  const latinPatterns = forms.filter((f) => !/\p{Script=Arabic}/u.test(f)).map((f) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(latin(f))}(?![\\p{L}\\p{N}])`, "u"));
  // Bare ك + أمل is also the unrelated word كامل; require ال after ك.
  const arabicPatterns = forms.filter((f) => /\p{Script=Arabic}/u.test(f)).map((f) => new RegExp(`^(?:[وف]?(?:[بل]?(?:ال)?|كال)|[وف]?لل)${escape(normalizeArabicName(f))}(?:ه|ها|هم|ي|ك|نا|ة|ات|ان|ين)?$`, "u"));
  for (const [language, content] of Object.entries(composition.languages || {})) {
    for (const field of fields) {
      const value = content[field];
      for (const text of Array.isArray(value) ? value : [value]) {
        if (typeof text !== "string") continue;
        // Normalize each token separately: normalizeArabicName itself removes spaces.
        const arabicTokens = text.split(/[^\p{L}\p{M}\u0640]+/u).map(normalizeArabicName);
        if (latinPatterns.some((pattern) => pattern.test(latin(text))) || arabicTokens.some((token) => arabicPatterns.some((pattern) => pattern.test(token)))) return { language, field };
      }
    }
  }
  return null;
}
export function assertNameRevealedLast(composition, brief) {
  if (findNameLeak(composition, brief)) throw new Error("Composition reveals the name too early.");
}
