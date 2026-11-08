// The paid preview renders these sections, in this order. Use their raw prose
// for speech, never the independent composition *Narration fields. Newlines
// supply pauses without adding words or changing the frozen composition receipt.
// Pure JS: shared by the Node worker and the Convex mutation runtime.
export const REVIEWED_STORY_SECTIONS = Object.freeze([
  Object.freeze(["introduction", "introLines"]),
  Object.freeze(["blessing", "blessingLines"]),
  Object.freeze(["closing", "closingLines"]),
]);

export function reviewedNarrationText(content) {
  return REVIEWED_STORY_SECTIONS.map(([, field]) => {
    const lines = content?.[field];
    if (!Array.isArray(lines) || !lines.length || lines.some((line) => typeof line !== "string" || !line.trim())) throw new Error("approved_content_mismatch");
    return lines.join("\n");
  }).join("\n\n");
}
