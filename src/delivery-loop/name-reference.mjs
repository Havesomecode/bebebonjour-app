import { resolveName } from "../../scripts/lib/name-resolution.mjs";
import referenceCatalog from "../../data/reference-catalog.json" with { type: "json" };

export { referenceCatalog };
export function resolveBriefName(brief) {
  const baby = { firstName: brief.firstName };
  if (brief.nameArabic != null) baby.nameArabic = brief.nameArabic;
  return resolveName({ baby, context: { religion: brief.religion } }, referenceCatalog);
}
// The verified catalog meaning ({ fr, ar }) of the brief's name, or null.
export function catalogMeaning(brief) {
  const resolution = resolveBriefName(brief);
  const meaning = resolution.status === "resolved" ? resolution.suggestions[0]?.meaning : null;
  return meaning?.fr && meaning?.ar ? { fr: meaning.fr, ar: meaning.ar } : null;
}
export function resolvedNameEntry(brief) {
  const resolution = resolveBriefName(brief);
  return { resolution, entry: resolution.status === "resolved" ? referenceCatalog.names[resolution.match.canonicalKey] : null };
}
// The name as written in Arabic text: the parents' form, else the catalog form, else as typed.
export function arabicNameForm(brief) {
  return brief.nameArabic ?? resolvedNameEntry(brief).entry?.canonical?.arabic ?? brief.firstName;
}
export function forbiddenNameForms(brief) {
  const { entry } = resolvedNameEntry(brief);
  return [...new Set([brief.firstName, brief.nameArabic, entry?.canonical?.latin, entry?.canonical?.arabic, ...(entry?.aliases?.latin || []), ...(entry?.aliases?.arabic || [])].filter(Boolean))];
}
