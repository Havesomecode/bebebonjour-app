function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeLatinName(value) {
  return normalizeText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("fr")
    .replace(/[’ʻʼ]/g, "'")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ");
}

export function normalizeArabicName(value) {
  return normalizeText(value)
    .normalize("NFKC")
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

export function resolveName(intake, catalog) {
  const arabicSupplied = Object.hasOwn(intake?.baby || {}, "nameArabic");
  const display = {
    latin: normalizeText(intake?.baby?.firstName),
    arabic: normalizeText(intake?.baby?.nameArabic) || null,
  };
  const normalized = {
    latin: normalizeLatinName(display.latin),
    arabic: display.arabic ? normalizeArabicName(display.arabic) : null,
  };
  if (arabicSupplied && !normalized.arabic) {
    return reviewRequired({
      display,
      normalized,
      kind: "invalid_orthography",
      candidates: [],
      reason: "name_arabic_normalizes_empty",
    });
  }
  const index = buildCatalogIndex(catalog);
  const latin = findCandidates(normalized.latin, index, "latin");
  const arabic = normalized.arabic
    ? findCandidates(normalized.arabic, index, "arabic")
    : emptyCandidates();

  if (latin.all.size > 1 || (normalized.arabic && arabic.all.size > 1)) {
    return reviewRequired({
      display,
      normalized,
      kind: "ambiguous",
      candidates: [...new Set([...latin.all, ...arabic.all])].sort(),
      reason: "name_match_ambiguous",
    });
  }

  if (normalized.arabic && latin.all.size > 0 && arabic.all.size > 0) {
    const shared = intersection(latin.all, arabic.all);
    if (shared.size === 0) {
      return reviewRequired({
        display,
        normalized,
        kind: "cross_script_conflict",
        candidates: [...new Set([...latin.all, ...arabic.all])].sort(),
        reason: "name_cross_script_conflict",
      });
    }
    return resolveCandidates({ display, normalized, candidates: shared, latin, arabic, catalog, intake });
  }

  if (normalized.arabic && (latin.all.size > 0 || arabic.all.size > 0)) {
    return reviewRequired({
      display,
      normalized,
      kind: "cross_script_conflict",
      candidates: [...new Set([...latin.all, ...arabic.all])].sort(),
      reason: "name_cross_script_conflict",
    });
  }

  if (latin.all.size > 0) {
    return resolveCandidates({ display, normalized, candidates: latin.all, latin, arabic, catalog, intake });
  }

  return unknownResolution({ display, normalized, catalog, intake });
}

function buildCatalogIndex(catalog) {
  const entries = [];
  for (const [canonicalKey, entry] of Object.entries(catalog?.names || {})) {
    const canonical = {
      latin: normalizeLatinName(entry?.canonical?.latin || canonicalKey),
      arabic: normalizeArabicName(entry?.canonical?.arabic),
    };
    const aliases = {
      latin: new Set((entry?.aliases?.latin || []).map(normalizeLatinName).filter(Boolean)),
      arabic: new Set((entry?.aliases?.arabic || []).map(normalizeArabicName).filter(Boolean)),
    };
    entries.push({ canonicalKey, entry, canonical, aliases });
  }
  return entries;
}

function findCandidates(value, entries, script) {
  const exact = new Set();
  const alias = new Set();
  if (!value) return { exact, alias, all: new Set() };

  for (const candidate of entries) {
    if (candidate.canonical[script] === value) exact.add(candidate.canonicalKey);
    if (candidate.aliases[script].has(value)) alias.add(candidate.canonicalKey);
  }
  return { exact, alias, all: new Set([...exact, ...alias]) };
}

function emptyCandidates() {
  return { exact: new Set(), alias: new Set(), all: new Set() };
}

function resolveCandidates({ display, normalized, candidates, latin, arabic, catalog, intake }) {
  const sortedCandidates = [...candidates].sort();
  if (sortedCandidates.length !== 1) {
    return reviewRequired({
      display,
      normalized,
      kind: "ambiguous",
      candidates: sortedCandidates,
      reason: "name_match_ambiguous",
    });
  }

  const canonicalKey = sortedCandidates[0];
  const exactLatin = latin.exact.has(canonicalKey);
  const exactArabic = !normalized.arabic || arabic.exact.has(canonicalKey);
  const kind = exactLatin && exactArabic ? "exact" : "alias";
  const reviewReasons = kind === "alias" ? ["name_alias_match"] : [];
  const entry = catalog.names[canonicalKey];
  const suggestions = suggestionsForResolvedName(entry, intake, kind);
  const sourceKeys = collectSourceKeys(suggestions);

  return {
    status: "resolved",
    display,
    normalized,
    match: { kind, canonicalKey, candidates: [canonicalKey] },
    confidence: kind === "exact" ? "high" : "medium",
    claimPolicy: {
      meaningAllowed: suggestions.some(hasMeaning),
      scripturalNameAssociationAllowed: suggestions.some(hasScripturalReferences),
      genericBlessingsAllowed: true,
    },
    reviewReasons,
    sourceKeys,
    suggestions,
  };
}

function unknownResolution({ display, normalized, catalog, intake }) {
  const religion = intake?.context?.religion || null;
  const source = religion
    ? catalog?.fallbacks?.religious?.[religion]
    : catalog?.fallbacks?.general;
  const fallback = source
    ? {
        ...source,
        confidence: "low",
        meaning: null,
        verses: { ar: [], fr: [] },
        claimPolicy: {
          meaningAllowed: false,
          scripturalNameAssociationAllowed: false,
          genericBlessingsAllowed: true,
        },
      }
    : null;

  return {
    status: "fallback",
    display,
    normalized,
    match: { kind: "unknown", canonicalKey: null, candidates: [] },
    confidence: "low",
    claimPolicy: {
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
    },
    reviewReasons: ["name_not_in_catalog"],
    sourceKeys: [],
    suggestions: fallback ? [fallback] : [],
  };
}

function reviewRequired({ display, normalized, kind, candidates, reason }) {
  return {
    status: "review_required",
    display,
    normalized,
    match: { kind, canonicalKey: null, candidates },
    confidence: "low",
    claimPolicy: {
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
    },
    reviewReasons: [reason],
    sourceKeys: [],
    suggestions: [],
  };
}

function suggestionsForResolvedName(entry, intake, matchKind) {
  const religion = intake?.context?.religion || null;
  let suggestions = [];
  if (religion && Array.isArray(entry?.religious?.[religion])) {
    suggestions = entry.religious[religion];
  } else if (Array.isArray(entry?.general)) {
    suggestions = entry.general;
  }

  return suggestions.map((candidate) => {
    const suggestion = {
      ...candidate,
      meaningSourceKeys: Array.isArray(candidate?.meaningSourceKeys)
        ? candidate.meaningSourceKeys.filter((sourceKey) => normalizeText(sourceKey))
        : [],
      verses: sourceBackedVerses(candidate?.verses),
    };
    return {
      ...suggestion,
      confidence: matchKind === "alias" && suggestion.confidence === "high"
        ? "medium"
        : suggestion.confidence || "medium",
      claimPolicy: {
        meaningAllowed: hasMeaning(suggestion),
        scripturalNameAssociationAllowed: hasScripturalReferences(suggestion),
        genericBlessingsAllowed: true,
      },
    };
  });
}

function sourceBackedVerses(verses) {
  return Object.fromEntries(
    Object.entries(verses || {}).map(([language, items]) => [
      language,
      Array.isArray(items)
        ? items.filter((item) => normalizeText(item?.sourceKey))
        : [],
    ]),
  );
}

function hasMeaning(suggestion) {
  const hasMeaningText = Boolean(
    suggestion?.meaning && Object.values(suggestion.meaning).some((value) => normalizeText(value)),
  );
  return hasMeaningText && (suggestion?.meaningSourceKeys || []).some(
    (sourceKey) => normalizeText(sourceKey),
  );
}

function hasScripturalReferences(suggestion) {
  return Object.values(suggestion?.verses || {}).some(
    (items) => Array.isArray(items) && items.some((item) => normalizeText(item?.sourceKey)),
  );
}

function collectSourceKeys(suggestions) {
  const keys = new Set();
  for (const suggestion of suggestions) {
    if (hasMeaning(suggestion)) {
      for (const sourceKey of suggestion.meaningSourceKeys) keys.add(sourceKey);
    }
    for (const items of Object.values(suggestion?.verses || {})) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (normalizeText(item?.sourceKey)) keys.add(item.sourceKey);
      }
    }
  }
  return [...keys].sort();
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}
