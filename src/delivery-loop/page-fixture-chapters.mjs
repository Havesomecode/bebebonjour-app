export function chaptersFromPageJson(page, language) {
  return page.sectionOrder.map((section) => {
    const content = page.sections[section][language];
    let phrases;
    if (section === 'reveal') {
      phrases = [{ text: content.introLines.join(' ') }, { text: language === 'ar' ? content.name : page.identity.nameLatin, name: { latin: page.identity.nameLatin, ...(page.identity.nameArabic ? { arabic: page.identity.nameArabic } : {}) } }];
    } else if (section === 'verses') {
      phrases = [{ text: content.introLine }, ...content.items.map((item) => ({ text: item.quote, reference: item.reference, ...(language === 'fr' && item.sourceArabic ? { arabic: item.sourceArabic } : {}) }))];
    } else {
      const lines = content.displayLines.filter((line) => line.trim());
      const merged = [];
      for (const line of lines) {
        if (merged.length && !/[.,;:!?…»،؛؟]$/u.test(merged.at(-1).trim())) merged[merged.length - 1] += ` ${line}`;
        else merged.push(line);
      }
      phrases = merged.map((text) => ({ text }));
    }
    return { section, phrases };
  });
}
