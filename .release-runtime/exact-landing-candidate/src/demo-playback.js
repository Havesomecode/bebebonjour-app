export function createDemoPlayback(manifest) {
  const announcements = validateManifest(manifest);
  let selectedIndex = 0;
  let stepIndex = 0;

  return Object.freeze({
    select(slug) {
      const nextIndex = announcements.findIndex((announcement) => announcement.slug === slug);
      if (nextIndex < 0) throw new Error("Select a built-in synthetic profile.");
      selectedIndex = nextIndex;
      stepIndex = 0;
      return snapshot();
    },
    advance() {
      const lastIndex = announcements[selectedIndex].timeline.length - 1;
      stepIndex = Math.min(stepIndex + 1, lastIndex);
      return snapshot();
    },
    reset() {
      selectedIndex = 0;
      stepIndex = 0;
      return snapshot();
    },
    snapshot,
  });

  function snapshot() {
    const announcement = announcements[selectedIndex];
    const step = announcement.timeline[stepIndex];
    const completed = stepIndex === announcement.timeline.length - 1;
    return Object.freeze({
      announcement,
      step,
      stepIndex,
      stepCount: announcement.timeline.length,
      completed,
      announcementPath: completed ? `demo/${announcement.path}/` : null,
    });
  }
}

function validateManifest(manifest) {
  if (manifest?.mode !== "synthetic-demo" || !Array.isArray(manifest.announcements)) {
    throw new Error("A synthetic demo manifest is required.");
  }
  if (manifest.announcements.length < 2) {
    throw new Error("The demo requires at least two built-in announcements.");
  }
  for (const announcement of manifest.announcements) {
    if (announcement?.simulated !== true
      || !/^[a-z0-9-]+$/.test(announcement.slug || "")
      || !Array.isArray(announcement.timeline)
      || announcement.timeline.length === 0) {
      throw new Error("The synthetic demo manifest is invalid.");
    }
  }
  return manifest.announcements;
}
