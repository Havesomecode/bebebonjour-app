#!/usr/bin/env node

import path from "node:path";

import { exportSyntheticDemo } from "../src/demo/synthetic-demo.mjs";

const outputArgument = process.argv[2];
if (!outputArgument) {
  throw new Error("Usage: node scripts/export-synthetic-demo.mjs <output-directory>");
}

const outputRoot = path.resolve(process.cwd(), outputArgument);
const manifest = await exportSyntheticDemo({ outputRoot });
console.log(JSON.stringify({
  mode: manifest.mode,
  announcements: manifest.announcements.map(({ slug, path: announcementPath }) => ({
    slug,
    path: announcementPath,
  })),
  outputRoot,
}, null, 2));
