import { readFile } from "node:fs/promises";
import { resolveName } from "../../scripts/lib/name-resolution.mjs";

export const referenceCatalog = JSON.parse(await readFile(new URL("../../data/reference-catalog.json", import.meta.url), "utf8"));
export function resolveBriefName(brief) {
  const baby = { firstName: brief.firstName };
  if (brief.nameArabic != null) baby.nameArabic = brief.nameArabic;
  return resolveName({ baby, context: { religion: brief.religion } }, referenceCatalog);
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
