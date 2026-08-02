import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_LANGUAGES = ["ar", "fr"];
export const SECTION_IDS = ["intro", "dua", "meaning", "reveal", "verses", "closing"];
export const DEFAULT_TEMPLATE_FAMILY = "blessed-arrival";
export const DEFAULT_TEMPLATE_VERSION = "1.0.0";
export const DEFAULT_RENDERER_VERSION = "1.0.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "../..");

export async function loadProjectEnv() {
  const candidates = [".env.local", ".env"];
  const loadedFiles = [];

  for (const candidate of candidates) {
    const envPath = path.join(PROJECT_ROOT, candidate);
    if (!(await exists(envPath))) continue;
    const raw = await readFile(envPath, "utf8");
    const parsed = parseEnvFile(raw);

    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    loadedFiles.push(envPath);
  }

  return loadedFiles;
}

export function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const [key, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
      continue;
    }

    args[key] = true;
  }

  return args;
}

export async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, value, "utf8");
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatSecondsMmss(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function estimateSecondsForText(text) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(4, Math.round((words / 130) * 60));
}

export function requireArg(args, name) {
  const value = args[name];
  if (!value || typeof value !== "string") {
    throw new Error(`Missing required --${name} argument`);
  }
  return value;
}

export function pageBaseFromSlug(slug) {
  return `/${slug}`;
}

export function buildIdFromPage(page) {
  const family = page.templateFamily || DEFAULT_TEMPLATE_FAMILY;
  const templateVersion = String(page.templateVersion || DEFAULT_TEMPLATE_VERSION).replace(/\./g, "-");
  const pageRevision = page.pageRevision || "r1";
  return slugify(`${family}-${templateVersion}-${pageRevision}`) || "build";
}

export function getRenderPaths(page, outputRoot) {
  const buildId = buildIdFromPage(page);
  const deployRoot = path.join(outputRoot, "deploy");
  const slugRoot = path.join(deployRoot, page.slug);
  const assetRoot = path.join(slugRoot, "_assets", buildId);

  return {
    buildId,
    outputRoot,
    deployRoot,
    slugRoot,
    assetRoot,
    appJsPath: path.join(assetRoot, "app.js"),
    stylesPath: path.join(assetRoot, "styles.css"),
    ogImagePath: path.join(assetRoot, "og-image.svg"),
    audioRoot: path.join(assetRoot, "audio"),
    transcriptPath: path.join(slugRoot, "transcript.json"),
    deployedPagePath: path.join(slugRoot, "page.json"),
    artifactsRoot: path.join(outputRoot, "artifacts"),
    currentPagePath: path.join(outputRoot, "artifacts", "current", "page.json"),
    currentTranscriptPath: path.join(outputRoot, "artifacts", "current", "transcript.json"),
    revisionsRoot: path.join(outputRoot, "artifacts", "revisions"),
    pageRevisionPath: path.join(outputRoot, "artifacts", "revisions", `${page.pageRevision}.page.json`),
    transcriptRevisionPath: path.join(
      outputRoot,
      "artifacts",
      "revisions",
      `${page.pageRevision}.transcript.json`,
    ),
    jobPath: path.join(outputRoot, "job.json"),
  };
}

export async function copyTemplateAsset(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await cp(sourcePath, targetPath, { force: true });
}

export function languageDisplayName(language) {
  return language === "ar" ? "Arabic" : "French";
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sectionNarrationText(section, language) {
  if (!section) return "";
  const entry = section[language];
  if (!entry) return "";
  if (typeof entry.narrationText === "string") return entry.narrationText.trim();
  return "";
}

function parseEnvFile(raw) {
  const parsed = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.indexOf(" #");
      if (commentIndex >= 0) {
        value = value.slice(0, commentIndex).trim();
      }
    }

    value = value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");

    if (key) {
      parsed[key] = value;
    }
  }

  return parsed;
}
