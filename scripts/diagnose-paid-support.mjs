#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { diagnosePaidSupport } from '../src/delivery-loop/support-diagnostics.mjs';

// Bounded file or stdin input. Never read environment credentials or connect to
// providers. Invalid snapshots get a fixed error with no input/path/stack echo.
const MAX_BYTES = 65536;
async function readSnapshot(argument) {
  let file;
  try {
    if (argument !== '-') {
      file = await open(argument, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid_input');
    }
    const stream = file ? file.createReadStream({ autoClose: false }) : process.stdin;
    let size = 0; const chunks = [];
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error('invalid_input');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await file?.close(); }
}
try {
  if (process.argv.length !== 3) throw new Error('invalid_input');
  const report = diagnosePaidSupport(await readSnapshot(process.argv[2]));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  process.stderr.write('support_diagnostics_invalid_input: supply one bounded redacted snapshot file or - for stdin; see docs/paid-support-diagnostics.md\n');
  process.exitCode = 2;
}
