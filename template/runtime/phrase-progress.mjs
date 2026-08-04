export function visiblePhraseTargetCount({
  rectTop,
  rectBottom,
  scrollY,
  viewportHeight,
  sectionStart,
  sectionHeight,
  itemCount,
}) {
  if (rectBottom <= 0) return itemCount;
  if (rectTop >= viewportHeight || rectBottom <= 0) return 0;

  const scrollSpan = Math.max(sectionHeight - viewportHeight, 1);
  const progress = (scrollY - sectionStart) / scrollSpan;
  const normalized = Math.max(0, Math.min(progress, 1));
  return Math.max(1, Math.ceil(normalized * itemCount));
}

export function shouldLoadNarrationResources({ privateReview, narrationRequested }) {
  return !privateReview && narrationRequested;
}

export function canonicalAnnouncementPath(pathname, language) {
  const segments = String(pathname || "").split("/").filter(Boolean);
  if (["ar", "fr"].includes(segments[segments.length - 1])) segments.pop();
  return `/${[...segments, language].join("/")}/`;
}
