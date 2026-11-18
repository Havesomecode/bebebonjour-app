import {
  DEFAULT_RENDERER_VERSION,
  DEFAULT_TEMPLATE_FAMILY,
  DEFAULT_TEMPLATE_VERSION,
  SECTION_IDS,
  SUPPORTED_LANGUAGES,
} from "./common.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isRevision(value) {
  return /^r[0-9]+$/.test(value);
}

export function validateIntake(intake) {
  const errors = [];

  if (!isPlainObject(intake)) return ["Intake must be an object."];
  if (intake.schemaVersion !== "1.0") errors.push("Intake schemaVersion must be 1.0.");
  if (!hasNonEmptyString(intake.requestId)) errors.push("Intake requestId is required.");
  if (!hasNonEmptyString(intake.submittedAt)) errors.push("Intake submittedAt is required.");

  const email = intake?.customer?.email;
  if (!hasNonEmptyString(email)) errors.push("customer.email is required.");

  const firstName = intake?.baby?.firstName;
  if (!hasNonEmptyString(firstName)) errors.push("baby.firstName is required.");

  if (!["girl", "boy", "neutral"].includes(intake?.baby?.gender)) {
    errors.push("baby.gender must be girl, boy, or neutral.");
  }

  if (!Array.isArray(intake.languages) || intake.languages.length === 0) {
    errors.push("languages must be a non-empty array.");
  } else if (intake.languages.some((language) => !SUPPORTED_LANGUAGES.includes(language))) {
    errors.push("languages may only include ar and fr.");
  }

  if (!["male", "female", "neutral"].includes(intake?.voicePreference?.gender)) {
    errors.push("voicePreference.gender must be male, female, or neutral.");
  }

  const sectionOrder = intake?.preferences?.sectionOrder;
  if (sectionOrder !== undefined) {
    errors.push(...validateSectionOrder(sectionOrder));
  }

  return errors;
}

export function validatePage(page) {
  const errors = [];

  if (!isPlainObject(page)) return ["Page must be an object."];
  if (page.schemaVersion !== "1.0") errors.push("Page schemaVersion must be 1.0.");
  if (!hasNonEmptyString(page.pageId)) errors.push("pageId is required.");
  if (!hasNonEmptyString(page.slug)) errors.push("slug is required.");
  else if (!isSafeSlug(page.slug)) {
    errors.push("slug must contain only lowercase letters, digits, and hyphens.");
  }
  if (!Array.isArray(page.languages) || page.languages.length === 0) {
    errors.push("languages must be a non-empty array.");
  } else if (page.languages.some((language) => !SUPPORTED_LANGUAGES.includes(language))) {
    errors.push("Page languages may only include ar and fr.");
  }

  if (!page.languages?.includes(page.defaultLanguage)) {
    errors.push("defaultLanguage must be included in page.languages.");
  }

  if (!hasNonEmptyString(page.templateFamily)) page.templateFamily = DEFAULT_TEMPLATE_FAMILY;
  if (!hasNonEmptyString(page.templateVersion)) page.templateVersion = DEFAULT_TEMPLATE_VERSION;
  if (!hasNonEmptyString(page.rendererVersion)) page.rendererVersion = DEFAULT_RENDERER_VERSION;
  if (!hasNonEmptyString(page.pageRevision)) errors.push("pageRevision is required.");
  else if (!isRevision(page.pageRevision)) errors.push("pageRevision must match r<number>.");

  if (!hasNonEmptyString(page?.identity?.nameLatin)) {
    errors.push("identity.nameLatin is required.");
  }
  if (!["girl", "boy", "neutral"].includes(page?.identity?.gender)) {
    errors.push("identity.gender must be girl, boy, or neutral.");
  }
  if (page.languages?.includes("ar") && !hasNonEmptyString(page?.identity?.nameArabic)) {
    errors.push("identity.nameArabic is required when Arabic is enabled.");
  }

  errors.push(...validateSectionOrder(page.sectionOrder));
  errors.push(...validateSections(page));

  if (!["draft", "approved", "rejected"].includes(page?.review?.status)) {
    errors.push("review.status must be draft, approved, or rejected.");
  }

  return errors;
}

export function validateJob(job) {
  const errors = [];
  if (!isPlainObject(job)) return ["Job must be an object."];
  if (job.schemaVersion !== "1.0") errors.push("Job schemaVersion must be 1.0.");
  if (!hasNonEmptyString(job.jobId)) errors.push("jobId is required.");
  if (!hasNonEmptyString(job.pageId)) errors.push("pageId is required.");
  if (!hasNonEmptyString(job.slug)) errors.push("slug is required.");
  else if (!isSafeSlug(job.slug)) {
    errors.push("slug must contain only lowercase letters, digits, and hyphens.");
  }
  if (!("currentLiveRevision" in job)) {
    errors.push("currentLiveRevision is required.");
  } else if (job.currentLiveRevision !== null && !isRevision(job.currentLiveRevision)) {
    errors.push("currentLiveRevision must match r<number>.");
  }
  if (job.currentPreparedRevision !== undefined && !isRevision(job.currentPreparedRevision)) {
    errors.push("currentPreparedRevision must match r<number>.");
  }
  return errors;
}

export function validateTranscript(transcript) {
  const errors = [];
  if (!isPlainObject(transcript)) return ["Transcript must be an object."];
  if (transcript.version !== 1) errors.push("Transcript version must be 1.");
  if (!isPlainObject(transcript.tracks)) errors.push("Transcript tracks are required.");
  return errors;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ["Manifest must be an object."];
  if (!hasNonEmptyString(manifest.language)) errors.push("Manifest language is required.");
  if (!Array.isArray(manifest.files)) errors.push("Manifest files must be an array.");
  return errors;
}

export function assertValidIntake(intake) {
  const errors = validateIntake(intake);
  if (errors.length) throw new Error(`Invalid intake:\n- ${errors.join("\n- ")}`);
}

export function assertValidPage(page) {
  const errors = validatePage(page);
  if (errors.length) throw new Error(`Invalid page:\n- ${errors.join("\n- ")}`);
}

export function assertValidJob(job) {
  const errors = validateJob(job);
  if (errors.length) throw new Error(`Invalid job:\n- ${errors.join("\n- ")}`);
}

function validateSectionOrder(sectionOrder) {
  const errors = [];
  if (!Array.isArray(sectionOrder) || sectionOrder.length !== SECTION_IDS.length) {
    return ["sectionOrder must include each supported section id exactly once."];
  }

  const seen = new Set();
  for (const sectionId of sectionOrder) {
    if (!SECTION_IDS.includes(sectionId)) {
      errors.push(`Unsupported section id in sectionOrder: ${sectionId}`);
      continue;
    }
    if (seen.has(sectionId)) errors.push(`Duplicate section id in sectionOrder: ${sectionId}`);
    seen.add(sectionId);
  }

  for (const sectionId of SECTION_IDS) {
    if (!seen.has(sectionId)) errors.push(`Missing supported section id in sectionOrder: ${sectionId}`);
  }
  return errors;
}

function validateSections(page) {
  const errors = [];
  if (!isPlainObject(page.sections)) {
    return ["sections are required."];
  }

  for (const sectionId of SECTION_IDS) {
    if (!isPlainObject(page.sections[sectionId])) {
      errors.push(`sections.${sectionId} is required.`);
      continue;
    }

    for (const language of Object.keys(page.sections[sectionId])) {
      if (!page.languages?.includes(language)) {
        errors.push(`Unsupported language key in sections.${sectionId}: ${language}`);
      }
    }

    if (sectionId === "verses") {
      for (const language of page.languages || []) {
        const entry = page.sections.verses[language];
        if (!isPlainObject(entry)) {
          errors.push(`sections.verses.${language} is required.`);
          continue;
        }
        if (!hasNonEmptyString(entry.introLine)) {
          errors.push(`sections.verses.${language}.introLine is required.`);
        }
        if (!Array.isArray(entry.items) || entry.items.length === 0) {
          errors.push(`sections.verses.${language}.items must be a non-empty array.`);
        }
        if (!hasNonEmptyString(entry.narrationText)) {
          errors.push(`sections.verses.${language}.narrationText is required.`);
        }
      }
      continue;
    }

    if (sectionId === "reveal") {
      for (const language of page.languages || []) {
        const entry = page.sections.reveal[language];
        if (!isPlainObject(entry)) {
          errors.push(`sections.reveal.${language} is required.`);
          continue;
        }
        if (!Array.isArray(entry.introLines) || entry.introLines.length === 0) {
          errors.push(`sections.reveal.${language}.introLines must be a non-empty array.`);
        }
        if (!hasNonEmptyString(entry.name)) {
          errors.push(`sections.reveal.${language}.name is required.`);
        }
        if (!hasNonEmptyString(entry.narrationText)) {
          errors.push(`sections.reveal.${language}.narrationText is required.`);
        }
      }
      continue;
    }

    for (const language of page.languages || []) {
      const entry = page.sections[sectionId][language];
      if (!isPlainObject(entry)) {
        errors.push(`sections.${sectionId}.${language} is required.`);
        continue;
      }
      if (!Array.isArray(entry.displayLines) || entry.displayLines.length === 0) {
        errors.push(`sections.${sectionId}.${language}.displayLines must be a non-empty array.`);
      }
      if (!hasNonEmptyString(entry.narrationText)) {
        errors.push(`sections.${sectionId}.${language}.narrationText is required.`);
      }
    }
  }

  return errors;
}
