import { spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
  PROJECT_ROOT,
  buildIdFromPage,
  cloneJson,
  copyTemplateAsset,
  DEFAULT_RENDERER_VERSION,
  DEFAULT_TEMPLATE_FAMILY,
  DEFAULT_TEMPLATE_VERSION,
  ensureDir,
  estimateSecondsForText,
  exists,
  formatSecondsMmss,
  getRenderPaths,
  languageDisplayName,
  nowIso,
  pageBaseFromSlug,
  readJson,
  requireArg,
  sectionNarrationText,
  slugify,
  writeJson,
  writeText,
} from "./common.mjs";
import { renderHtml } from "./render-html.mjs";
import { assertValidIntake, assertValidJob, assertValidPage } from "./validators.mjs";

const TEMPLATE_APP_PATH = path.join(PROJECT_ROOT, "template", "runtime", "app.js");
const TEMPLATE_STYLES_PATH = path.join(PROJECT_ROOT, "template", "runtime", "styles.css");
const TEMPLATE_OG_PATH = path.join(PROJECT_ROOT, "template", "assets", "og-image.svg");
const REFERENCE_CATALOG_PATH = path.join(PROJECT_ROOT, "data", "reference-catalog.json");
const VERCEL_PROJECT_LINK_PATH = path.join(PROJECT_ROOT, ".vercel", "project.json");

export async function commandCompose(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const output = path.resolve(process.cwd(), requireArg(args, "output"));
  const intake = await readJson(input);
  assertValidIntake(intake);

  const catalog = await readJson(REFERENCE_CATALOG_PATH);
  const suggestions = buildSuggestions(intake, catalog);
  const selectionId = typeof args.select === "string" ? args.select : null;

  if (!suggestions.length) {
    const blocked = {
      state: "blocked",
      reason: "No suitable references or meanings were found for this intake.",
      nextAction: "Decide whether to continue with general wishes or provide operator-authored content.",
    };
    console.log(JSON.stringify(blocked, null, 2));
    process.exitCode = 3;
    return;
  }

  if (!selectionId && suggestions.length > 1) {
    console.log(
      JSON.stringify(
        {
          state: "selection_required",
          suggestions: suggestions.map(({ id, label, basis, confidence }) => ({
            id,
            label,
            basis,
            confidence,
          })),
        },
        null,
        2,
      ),
    );
    process.exitCode = 3;
    return;
  }

  const selected = selectionId
    ? suggestions.find((suggestion) => suggestion.id === selectionId)
    : suggestions[0];

  if (!selected) {
    throw new Error(`Unknown compose selection: ${selectionId}`);
  }

  const page = buildDraftPage(intake, selected);
  assertValidPage(page);
  await writeJson(output, page);

  console.log(
    JSON.stringify(
      {
        state: "draft_created",
        output,
        suggestion: {
          id: selected.id,
          label: selected.label,
        },
        reviewStatus: page.review.status,
      },
      null,
      2,
    ),
  );
}

export async function commandRender(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const page = await readJson(input);
  assertValidPage(page);

  if (page.review.status !== "approved" && !args["allow-draft"]) {
    throw new Error("Render requires an approved page. Pass --allow-draft to override.");
  }

  const renderPaths = getRenderPaths(page, outputRoot);
  await ensureDir(renderPaths.assetRoot);
  await ensureDir(renderPaths.revisionsRoot);
  await ensureDir(path.join(renderPaths.slugRoot, "ar"));
  await ensureDir(path.join(renderPaths.slugRoot, "fr"));
  await copyTemplateAsset(TEMPLATE_APP_PATH, renderPaths.appJsPath);
  await copyTemplateAsset(TEMPLATE_STYLES_PATH, renderPaths.stylesPath);
  await copyTemplateAsset(TEMPLATE_OG_PATH, renderPaths.ogImagePath);

  const transcript = buildTranscript(page);
  const canonicalPage = cloneJson(page);
  canonicalPage.buildId = renderPaths.buildId;
  const publicPage = buildPublicPage(canonicalPage);

  await writeJson(renderPaths.deployedPagePath, publicPage);
  await writeJson(renderPaths.currentPagePath, canonicalPage);
  await writeJson(renderPaths.pageRevisionPath, canonicalPage);
  await writeJson(renderPaths.transcriptPath, transcript);
  await writeJson(renderPaths.currentTranscriptPath, transcript);
  await writeJson(renderPaths.transcriptRevisionPath, transcript);

  for (const language of page.languages) {
    const languageDir = path.join(renderPaths.slugRoot, language);
    const assetBasePath = `../_assets/${renderPaths.buildId}`;
    const transcriptUrl = "../transcript.json";
    const ambientAudioUrl = `${assetBasePath}/audio/ambient.mp3`;
    const html = renderHtml({
      page,
      language,
      assetBasePath,
      transcriptUrl,
      ambientAudioUrl,
    });
    await writeText(path.join(languageDir, "index.html"), html);
  }

  const job = (await exists(renderPaths.jobPath))
    ? updateJobForRenderedRevision(await readJson(renderPaths.jobPath), page, input, renderPaths)
    : buildJobFromPage(page, input, renderPaths);
  job.status = "rendered";
  await writeJson(renderPaths.jobPath, job);

  console.log(
    JSON.stringify(
      {
        state: "rendered",
        outputRoot,
        deployRoot: renderPaths.deployRoot,
        slugRoot: renderPaths.slugRoot,
        buildId: renderPaths.buildId,
      },
      null,
      2,
    ),
  );
}

export async function commandTts(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const languageArg = typeof args.lang === "string" ? args.lang : "all";
  const selectedLanguages = languageArg === "all" ? null : languageArg.split(",");
  const page = await readJson(input);
  assertValidPage(page);
  const renderPaths = getRenderPaths(page, outputRoot);
  const transcript = await readJson(renderPaths.transcriptPath);
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY for TTS generation.");
  }

  const activeLanguages = selectedLanguages || page.languages;
  const results = [];
  let partialFailure = false;

  for (const language of activeLanguages) {
    try {
      const manifest = await generateNarrationForLanguage({
        apiKey,
        language,
        page,
        renderPaths,
        force: Boolean(args.force),
      });
      results.push({ language, status: "ok", files: manifest.files.length });
    } catch (error) {
      partialFailure = true;
      results.push({ language, status: "failed", error: error.message });
    }
  }

  const updatedTranscript = await rebuildTranscriptTimes(page, renderPaths, transcript);
  await writeJson(renderPaths.transcriptPath, updatedTranscript);
  await writeJson(renderPaths.currentTranscriptPath, updatedTranscript);
  await writeJson(renderPaths.transcriptRevisionPath, updatedTranscript);

  const job = await loadOrCreateJob(page, input, renderPaths);
  job.status = partialFailure ? "tts_partial" : "tts_complete";
  job.lastNarrationGeneratedAt = nowIso();
  job.narration = {
    generatedForLanguages: activeLanguages,
    partialFailure,
  };
  await writeJson(renderPaths.jobPath, job);

  console.log(JSON.stringify({ state: job.status, results }, null, 2));
  if (partialFailure) process.exitCode = 9;
}

export async function commandDeploy(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const jobPath = args.job ? path.resolve(process.cwd(), args.job) : path.join(input, "job.json");
  const job = await readJson(jobPath);
  assertValidJob(job);

  const deployRoot = path.join(input, "deploy");
  if (!job.paths?.deployRoot || path.resolve(process.cwd(), job.paths.deployRoot) !== deployRoot) {
    throw new Error("Deploy input must match the deploy root recorded in the job.");
  }
  if (!(await exists(deployRoot))) {
    throw new Error(`Missing deploy directory: ${deployRoot}`);
  }

  await assertApprovedPreparedRevision(job, deployRoot);

  if (args["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          state: "deploy_ready",
          deployRoot,
          revision: job.currentPreparedRevision,
        },
        null,
        2,
      ),
    );
    return;
  }

  const token = process.env.VERCEL_TOKEN;
  await ensureVercelProjectLink();
  const vercelArgs = ["deploy", deployRoot, "--prod", "--yes"];
  if (token) {
    vercelArgs.push("--token", token);
  }

  const result = spawnSync("vercel", vercelArgs, {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Vercel deploy failed.");
  }

  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
  const aliasedUrl = findUrlInLines(lines, "Aliased:");
  const productionUrl = findUrlInLines(lines, "Production:");
  const publicUrl = aliasedUrl || productionUrl || findFirstUrl(lines);
  job.status = "deployed";
  job.currentLiveRevision = job.currentPreparedRevision || job.currentLiveRevision;
  job.deploy = {
    provider: "vercel",
    deployedAt: nowIso(),
    deployRoot,
    publicUrl: publicUrl || null,
    rawOutput: lines.slice(-10),
  };
  await writeJson(jobPath, job);

  console.log(JSON.stringify({ state: "deployed", publicUrl }, null, 2));
}

export async function commandSend(args) {
  const jobPath = path.resolve(process.cwd(), requireArg(args, "job"));
  const provider = typeof args.provider === "string" ? args.provider : "console";
  const job = await readJson(jobPath);
  assertValidJob(job);

  if (!job.deploy?.publicUrl) {
    throw new Error("Cannot send delivery without a publicUrl in job.deploy.");
  }

  if (provider !== "console") {
    throw new Error(`Unsupported send provider: ${provider}`);
  }

  console.log(
    JSON.stringify(
      {
        state: "delivery_preview",
        provider,
        recipientConfigured: Boolean(job.customer?.email),
        publicUrlConfigured: true,
      },
      null,
      2,
    ),
  );
}

export async function commandStatus(args) {
  const target = args.job ? path.resolve(process.cwd(), args.job) : null;
  if (!target) {
    throw new Error("status requires --job <job.json>");
  }

  const job = await readJson(target);
  assertValidJob(job);
  const payload = {
    jobId: job.jobId,
    status: job.status,
    pageId: job.pageId,
    slug: job.slug,
    currentPreparedRevision: job.currentPreparedRevision || null,
    currentLiveRevision: job.currentLiveRevision || null,
    templateVersion: job.templateVersion,
    rendererVersion: job.rendererVersion,
    publicUrl: job.deploy?.publicUrl || null,
    email: job.email?.status || "pending",
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Job: ${payload.jobId}`);
  console.log(`Status: ${payload.status}`);
  console.log(`Slug: ${payload.slug}`);
  console.log(`Prepared Revision: ${payload.currentPreparedRevision ?? "none"}`);
  console.log(`Live Revision: ${payload.currentLiveRevision ?? "none"}`);
  console.log(`Template: ${payload.templateVersion}`);
  console.log(`Renderer: ${payload.rendererVersion}`);
  console.log(`Public URL: ${payload.publicUrl ?? "not deployed"}`);
  console.log(`Email: ${payload.email}`);
}

function buildSuggestions(intake, catalog) {
  const slug = slugify(intake.baby.firstName);
  const religion = intake?.context?.religion || null;
  const nameEntry = catalog.names?.[slug] || null;
  const suggestions = [];

  if (religion && nameEntry?.religious?.[religion]) {
    suggestions.push(...nameEntry.religious[religion]);
  }

  if (!religion && Array.isArray(nameEntry?.general)) {
    suggestions.push(...nameEntry.general);
  }

  if (!suggestions.length && religion && catalog.fallbacks?.religious?.[religion]) {
    suggestions.push(catalog.fallbacks.religious[religion]);
  }

  if (!suggestions.length && catalog.fallbacks?.general) {
    suggestions.push(catalog.fallbacks.general);
  }

  return suggestions.map((suggestion) => ({
    ...suggestion,
    label: suggestion.label || `${languageDisplayName("ar")} / ${languageDisplayName("fr")} draft`,
    confidence: suggestion.confidence || "medium",
    basis: suggestion.basis || (religion ? `religious:${religion}` : "general"),
  }));
}

function buildDraftPage(intake, suggestion) {
  const slug = slugify(intake.slug || intake.baby.firstName);
  const pageId = `page_${slug}_${intake.requestId}`;
  const pageRevision = "r1";
  const sectionOrder = Array.isArray(intake?.preferences?.sectionOrder)
    ? intake.preferences.sectionOrder
    : ["intro", "dua", "meaning", "reveal", "verses", "closing"];
  const languages = intake.languages;
  const nameLatin = intake.baby.firstName;
  const nameArabic = intake.baby.nameArabic || nameLatin;
  const childLabel = intake.baby.gender === "boy"
    ? { ar: "بابننا", fr: "notre fils" }
    : { ar: "بابنتنا", fr: "notre fille" };

  const sections = buildSections({
    intake,
    suggestion,
    childLabel,
    nameLatin,
    nameArabic,
    languages,
  });

  return {
    schemaVersion: "1.0",
    pageId,
    slug,
    languages,
    defaultLanguage: languages.includes("ar") ? "ar" : languages[0],
    templateFamily: DEFAULT_TEMPLATE_FAMILY,
    templateVersion: DEFAULT_TEMPLATE_VERSION,
    rendererVersion: DEFAULT_RENDERER_VERSION,
    pageRevision,
    featureFlags: suggestion.featureFlags || [],
    sectionOrder,
    identity: {
      nameLatin,
      nameArabic,
      gender: intake.baby.gender,
      childLabel,
    },
    seo: {
      title: `Une Naissance Bénie | ${nameLatin}`,
      description: suggestion.description || `A birth announcement page for ${nameLatin}.`,
      ogImageMode: "static",
    },
    sections,
    audioPlan: {
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voiceByLanguage: {
        ar: intake.voicePreference.gender === "female" ? "alloy" : "onyx",
        fr: intake.voicePreference.gender === "female" ? "alloy" : "onyx",
      },
      instructionsByLanguage: {
        ar: "Soft, spiritual, contemplative, and warm.",
        fr: "Soft, spiritual, contemplative, and warm.",
      },
    },
    review: {
      status: "draft",
      reviewedBy: null,
      reviewedAt: null,
    },
    provenance: {
      sourceRequestId: intake.requestId,
      composeSuggestionId: suggestion.id,
      composeBasis: suggestion.basis,
      customerEmail: intake.customer.email,
    },
  };
}

function buildSections({ intake, suggestion, childLabel, nameLatin, nameArabic, languages }) {
  const religion = intake?.context?.religion || null;
  const sections = {};
  const meaning = suggestion.meaning || {};
  const verses = suggestion.verses || { ar: [], fr: [] };

  sections.intro = {};
  sections.dua = {};
  sections.meaning = {};
  sections.reveal = {};
  sections.verses = {};
  sections.closing = {};

  if (languages.includes("ar")) {
    sections.intro.ar = {
      displayLines: suggestion.arIntroLines || [
        "بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ.",
        `بفضل الله استقبلنا ${childLabel.ar} ${nameArabic}.`,
      ],
      narrationText:
        suggestion.arIntroNarration ||
        `بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ. بفضل الله استقبلنا ${childLabel.ar} ${nameArabic}.`,
    };
    sections.dua.ar = {
      displayLines:
        religion === "islam"
          ? suggestion.arDuaLines || [
              `نسأل الله أن يجعل ${nameArabic} قرة عين لنا،`,
              "وأن يبارك في أيامها ويجعلها نورًا ورحمة.",
            ]
          : suggestion.arWishLines || [
              `نتمنى لـ ${nameArabic} حياة مليئة بالنور والسكينة،`,
              "وأيامًا لطيفة وبركة لمن حولها.",
            ],
      narrationText:
        religion === "islam"
          ? suggestion.arDuaNarration ||
            `نسأل الله أن يجعل ${nameArabic} قرة عين لنا، وأن يبارك في أيامها ويجعلها نورًا ورحمة.`
          : suggestion.arWishNarration ||
            `نتمنى لـ ${nameArabic} حياة مليئة بالنور والسكينة، وأيامًا لطيفة وبركة لمن حولها.`,
    };
    sections.meaning.ar = {
      displayLines: suggestion.arMeaningLines || [
        `اخترنا اسم ${nameArabic} لما يحمله من معنى ${meaning.ar || "جميل"}.`,
        "اسم يترك أثرًا من الوضوح والطمأنينة.",
      ],
      narrationText:
        suggestion.arMeaningNarration ||
        `اخترنا اسم ${nameArabic} لما يحمله من معنى ${meaning.ar || "جميل"}. اسم يترك أثرًا من الوضوح والطمأنينة.`,
    };
    sections.reveal.ar = {
      introLines: suggestion.arRevealIntroLines || ["بفضل الله ومنته", `رزقنا ${childLabel.ar}...`],
      name: suggestion.arRevealName || nameArabic,
      narrationText:
        suggestion.arRevealNarration || `بفضل الله ومنته رزقنا ${childLabel.ar} ${nameArabic}.`,
    };
    sections.verses.ar = {
      introLine: religion === "islam" ? "قال تعالى:" : "معانٍ وإشارات:",
      items: verses.ar.length
        ? verses.ar
        : [{ quote: "نور وأمل ورحمة", reference: "إشارة عامة", sourceKey: "general-ar" }],
      narrationText:
        suggestion.arVersesNarration ||
        (verses.ar.length
          ? verses.ar.map((item) => `${item.quote} ${item.reference}`).join(" ")
          : "نور وأمل ورحمة."),
    };
    sections.closing.ar = {
      displayLines: suggestion.arClosingLines || [
        `اللهم بارك في ${nameArabic}.`,
        "واجعل أيامها لطفًا ورحمة وسكينة.",
      ],
      narrationText:
        suggestion.arClosingNarration ||
        `اللهم بارك في ${nameArabic}. واجعل أيامها لطفًا ورحمة وسكينة.`,
    };
  }

  if (languages.includes("fr")) {
    sections.intro.fr = {
      displayLines: suggestion.frIntroLines || [
        `Par la grâce de Dieu, nous avons accueilli ${childLabel.fr}.`,
        `${nameLatin} est entrée dans nos vies avec douceur.`,
      ],
      narrationText:
        suggestion.frIntroNarration ||
        `Par la grâce de Dieu, nous avons accueilli ${childLabel.fr}. ${nameLatin} est entrée dans nos vies avec douceur.`,
    };
    sections.dua.fr = {
      displayLines:
        religion === "islam"
          ? suggestion.frDuaLines || [
              `Nous demandons à Dieu de bénir ${nameLatin},`,
              "et de faire de ses jours une lumière et une miséricorde.",
            ]
          : suggestion.frWishLines || [
              `Nous souhaitons à ${nameLatin} une vie douce et lumineuse,`,
              "faite de paix, de tendresse et de joie.",
            ],
      narrationText:
        religion === "islam"
          ? suggestion.frDuaNarration ||
            `Nous demandons à Dieu de bénir ${nameLatin}, et de faire de ses jours une lumière et une miséricorde.`
          : suggestion.frWishNarration ||
            `Nous souhaitons à ${nameLatin} une vie douce et lumineuse, faite de paix, de tendresse et de joie.`,
    };
    sections.meaning.fr = {
      displayLines: suggestion.frMeaningLines || [
        `Nous avons choisi ${nameLatin} pour la beauté de son sens : ${meaning.fr || "une belle signification"}.`,
        "Un nom porté par la clarté et l'espérance.",
      ],
      narrationText:
        suggestion.frMeaningNarration ||
        `Nous avons choisi ${nameLatin} pour la beauté de son sens : ${meaning.fr || "une belle signification"}. Un nom porté par la clarté et l'espérance.`,
    };
    sections.reveal.fr = {
      introLines: suggestion.frRevealIntroLines || ["Par la grâce de Dieu,", `nous avons accueilli ${childLabel.fr}...`],
      name: suggestion.frRevealName || nameLatin.toUpperCase(),
      narrationText:
        suggestion.frRevealNarration || `Par la grâce de Dieu, nous avons accueilli ${childLabel.fr} ${nameLatin}.`,
    };
    sections.verses.fr = {
      introLine: religion === "islam" ? "Références proposées :" : "Sens et échos proposés :",
      items: verses.fr.length
        ? verses.fr
        : [{ quote: "Lumière, paix et espérance.", reference: "Référence générale", sourceKey: "general-fr" }],
      narrationText:
        suggestion.frVersesNarration ||
        (verses.fr.length
          ? verses.fr.map((item) => `${item.quote} ${item.reference}`).join(" ")
          : "Lumière, paix et espérance."),
    };
    sections.closing.fr = {
      displayLines: suggestion.frClosingLines || [
        `Que ${nameLatin} grandisse dans la paix et la lumière,`,
        "et qu'elle soit une joie pour ceux qui l'entourent.",
      ],
      narrationText:
        suggestion.frClosingNarration ||
        `Que ${nameLatin} grandisse dans la paix et la lumière, et qu'elle soit une joie pour ceux qui l'entourent.`,
    };
  }

  return sections;
}

function buildTranscript(page) {
  const transcript = { version: 1, tracks: {} };

  for (const language of page.languages) {
    let rolling = 0;
    transcript.tracks[language] = page.sectionOrder.map((sectionId) => {
      const text = sectionNarrationText(page.sections[sectionId], language);
      const entry = {
        section: sectionId,
        text,
        time: formatSecondsMmss(rolling),
        seconds: rolling,
      };
      rolling += estimateSecondsForText(text);
      return entry;
    });
  }

  return transcript;
}

function buildJobFromPage(page, inputPath, renderPaths) {
  return {
    schemaVersion: "1.0",
    jobId: `job_${page.slug}`,
    pageId: page.pageId,
    slug: page.slug,
    status: "created",
    templateFamily: page.templateFamily,
    templateVersion: page.templateVersion,
    rendererVersion: page.rendererVersion,
    currentPreparedRevision: page.pageRevision,
    currentLiveRevision: null,
    paths: {
      sourcePage: inputPath,
      currentPage: renderPaths.currentPagePath,
      currentTranscript: renderPaths.currentTranscriptPath,
      deployRoot: renderPaths.deployRoot,
    },
    customer: {
      email: page.provenance?.customerEmail || null,
      nameLatin: page.identity.nameLatin,
      nameArabic: page.identity.nameArabic,
      languages: page.languages,
    },
    review: cloneJson(page.review),
    deploy: null,
    email: {
      status: "pending",
    },
    revisionHistory: [
      {
        revision: page.pageRevision,
        renderedAt: nowIso(),
        buildId: renderPaths.buildId,
      },
    ],
  };
}

function updateJobForRenderedRevision(job, page, inputPath, renderPaths) {
  const next = cloneJson(job);
  const alreadyTracked = (next.revisionHistory || []).some((entry) => entry.revision === page.pageRevision);

  next.pageId = page.pageId;
  next.slug = page.slug;
  next.templateFamily = page.templateFamily;
  next.templateVersion = page.templateVersion;
  next.rendererVersion = page.rendererVersion;
  next.currentPreparedRevision = page.pageRevision;
  next.paths = {
    sourcePage: inputPath,
    currentPage: renderPaths.currentPagePath,
    currentTranscript: renderPaths.currentTranscriptPath,
    deployRoot: renderPaths.deployRoot,
  };
  next.customer = {
    email: page.provenance?.customerEmail || next.customer?.email || null,
    nameLatin: page.identity.nameLatin,
    nameArabic: page.identity.nameArabic,
    languages: page.languages,
  };
  next.review = cloneJson(page.review);
  next.revisionHistory = next.revisionHistory || [];

  if (!alreadyTracked) {
    next.revisionHistory.push({
      revision: page.pageRevision,
      renderedAt: nowIso(),
      buildId: renderPaths.buildId,
    });
  }

  return next;
}

function buildPublicPage(page) {
  const {
    schemaVersion,
    pageId,
    slug,
    languages,
    defaultLanguage,
    templateFamily,
    templateVersion,
    rendererVersion,
    pageRevision,
    buildId,
    sectionOrder,
    identity,
    seo,
    sections,
    audioPlan,
  } = page;

  return cloneJson({
    schemaVersion,
    pageId,
    slug,
    languages,
    defaultLanguage,
    templateFamily,
    templateVersion,
    rendererVersion,
    pageRevision,
    buildId,
    sectionOrder,
    identity,
    seo,
    sections,
    audioPlan,
  });
}

async function assertApprovedPreparedRevision(job, deployRoot) {
  if (job.review?.status !== "approved") {
    throw new Error("Deploy requires an approved page revision.");
  }

  const currentPagePath = job.paths?.currentPage;
  if (!currentPagePath || !(await exists(currentPagePath))) {
    throw new Error("Deploy requires the canonical prepared page artifact.");
  }

  const page = await readJson(currentPagePath);
  assertValidPage(page);
  if (page.review?.status !== "approved" || page.pageRevision !== job.currentPreparedRevision) {
    throw new Error("Deploy requires an approved page revision matching the prepared job revision.");
  }

  if (typeof page.buildId !== "string" || page.buildId.length === 0) {
    throw new Error("Deploy requires a prepared page build identifier.");
  }

  const publicPagePath = path.join(deployRoot, page.slug, "page.json");
  if (!(await exists(publicPagePath))) {
    throw new Error("Deploy requires the prepared public page artifact.");
  }
  const publicPage = await readJson(publicPagePath);
  if (!isDeepStrictEqual(publicPage, buildPublicPage(page))) {
    throw new Error("The public deploy bundle does not match the approved prepared page.");
  }
}

async function loadOrCreateJob(page, inputPath, renderPaths) {
  if (await exists(renderPaths.jobPath)) {
    return readJson(renderPaths.jobPath);
  }
  return buildJobFromPage(page, inputPath, renderPaths);
}

async function generateNarrationForLanguage({ apiKey, language, page, renderPaths, force }) {
  const audioDir = path.join(renderPaths.audioRoot, "narration", language);
  await ensureDir(audioDir);
  const track = page.sectionOrder.map((sectionId, index) => ({
    index: index + 1,
    section: sectionId,
    text: sectionNarrationText(page.sections[sectionId], language),
  }));

  const manifest = {
    language,
    provider: page.audioPlan.provider,
    model: page.audioPlan.model,
    voice: page.audioPlan.voiceByLanguage[language],
    generatedAt: nowIso(),
    files: [],
  };

  let rolling = 0;
  for (const segment of track) {
    const filename = `${String(segment.index).padStart(2, "0")}-${segment.section}.mp3`;
    const outPath = path.join(audioDir, filename);
    if (!force && (await exists(outPath))) {
      const seconds = await probeDurationSeconds(outPath);
      manifest.files.push({
        index: segment.index,
        section: segment.section,
        time: formatSecondsMmss(rolling),
        seconds: rolling,
        file: `../_assets/${renderPaths.buildId}/audio/narration/${language}/${filename}`,
      });
      rolling += seconds || estimateSecondsForText(segment.text);
      continue;
    }

    const audioBytes = await requestSpeech({
      apiKey,
      model: page.audioPlan.model,
      voice: page.audioPlan.voiceByLanguage[language],
      input: segment.text,
      instructions: page.audioPlan.instructionsByLanguage[language],
    });
    await writeFile(outPath, audioBytes);
    const seconds = await probeDurationSeconds(outPath);
    manifest.files.push({
      index: segment.index,
      section: segment.section,
      time: formatSecondsMmss(rolling),
      seconds: rolling,
      file: `../_assets/${renderPaths.buildId}/audio/narration/${language}/${filename}`,
    });
    rolling += seconds || estimateSecondsForText(segment.text);
  }

  const manifestPath = path.join(audioDir, "manifest.json");
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function requestSpeech({ apiKey, model, voice, input, instructions }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input,
      format: "mp3",
      instructions,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TTS request failed (${response.status}): ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function rebuildTranscriptTimes(page, renderPaths, transcript) {
  const next = cloneJson(transcript);

  for (const language of page.languages) {
    const manifestPath = path.join(renderPaths.audioRoot, "narration", language, "manifest.json");
    if (!(await exists(manifestPath))) continue;
    const manifest = await readJson(manifestPath);
    next.tracks[language] = next.tracks[language].map((entry, index) => {
      const fileEntry = manifest.files[index];
      if (!fileEntry) return entry;
      return {
        ...entry,
        time: fileEntry.time,
        seconds: fileEntry.seconds,
      };
    });
  }

  return next;
}

async function probeDurationSeconds(filePath) {
  const ffprobe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf8" });

  if (ffprobe.status === 0) {
    const value = Number.parseFloat(ffprobe.stdout.trim());
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function findUrlInLines(lines, prefix) {
  for (const line of lines) {
    if (!line.includes(prefix)) continue;
    const match = line.match(/https:\/\/\S+/);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function findFirstUrl(lines) {
  for (const line of lines) {
    const match = line.match(/https:\/\/\S+/);
    if (match) {
      return match[0];
    }
  }
  return null;
}

async function ensureVercelProjectLink() {
  if (await exists(VERCEL_PROJECT_LINK_PATH)) return;

  const orgId = process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!orgId || !projectId) return;

  await ensureDir(path.dirname(VERCEL_PROJECT_LINK_PATH));
  await writeJson(VERCEL_PROJECT_LINK_PATH, { orgId, projectId });
}
