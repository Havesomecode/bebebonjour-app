import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chaptersFromPageJson } from '../src/delivery-loop/page-fixture-chapters.mjs';
import { renderAnnouncement } from '../src/delivery-loop/render.mjs';
const [input, output, ...args] = process.argv.slice(2);
if (!input || !output || args.some(arg => !arg.startsWith('--starts='))) throw new Error('usage: render-r1-fixture.mjs <page.json> <outDir> [--starts=fr:0,1.5,...]');
const page = JSON.parse(await readFile(input, 'utf8'));
const languages = [...page.languages].sort((a, b) => a === 'fr' ? -1 : b === 'fr' ? 1 : 0);
const phraseStarts = {};
for (const arg of args) { const [lang, values] = arg.slice(9).split(':'); if (!values || !languages.includes(lang)) throw new Error('invalid starts'); phraseStarts[lang] = values.split(',').map(Number); }
const chapters = Object.fromEntries(languages.map(lang => [lang, chaptersFromPageJson(page, lang)]));
const html = renderAnnouncement({ chapters, languages, phraseStarts, publicToken: 'fixture', publicUrl: 'https://www.bebebonjour.com/announcements/fixture', revision: 1 });
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'index.html'), html);
