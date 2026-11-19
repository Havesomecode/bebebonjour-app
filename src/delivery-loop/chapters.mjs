import { assertValidCodexSubscriptionComposition } from "../../scripts/lib/codex-subscription-composition.mjs";
import { assertNameRevealedLast } from "./name-leak.mjs";
import { arabicNameForm, resolvedNameEntry } from "./name-reference.mjs";

export function buildAnnouncementChapters({ composition, brief }) {
  assertValidCodexSubscriptionComposition(composition);
  assertNameRevealedLast(composition, brief);
  const { resolution } = resolvedNameEntry(brief);
  const arabic = arabicNameForm(brief);
  return Object.fromEntries(brief.languages.map((language) => {
    const c = composition.languages[language];
    const section = (section, lines) => ({ section, phrases: lines.map((text) => ({ text })) });
    const chapters = [section("intro", c.introLines), section("dua", c.blessingLines), section("meaning", c.meaningLines), section("reveal", c.revealLines)];
    chapters[3].phrases.push({ text: language === "ar" ? arabic : brief.firstName, name: { latin: brief.firstName, arabic } });
    const verses = resolution.status === "resolved" && brief.religion === "islam" ? resolution.suggestions[0]?.verses?.[language] : null;
    if (verses?.length) chapters.push({ section: "verses", phrases: verses.map((v) => language === "fr" ? { text: v.quote, reference: v.reference, arabic: v.sourceArabic, sourceKey: v.sourceKey } : { text: v.quote, reference: v.reference, sourceKey: v.sourceKey }) });
    chapters.push(section("closing", c.closingLines));
    return [language, chapters];
  }));
}
