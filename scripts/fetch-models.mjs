// Download the ZEN-TTS model weights from the upstream repository, pinned to one commit, and check
// every file against the sha256 in upstream models/manifest.json.
//
// The weights are not part of this repository and are never redistributed (ZEN-TTS License 1.0,
// section 3.3). Each machine fetches them from zenryokukikai/zen-tts itself.
//
//   node scripts/fetch-models.mjs [dest]      (default: ZEN_TTS_MODELS or ./models)

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// zenryokukikai/zen-tts tag v1.0.0. Keep in sync with the zen-tts dependency in package.json.
export const UPSTREAM_COMMIT = '127d26aa956dd3e3bdc797ab147500b0d95f2247';
const RAW = `https://raw.githubusercontent.com/zenryokukikai/zen-tts/${UPSTREAM_COMMIT}/models`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function existingMatches(path, want) {
  try {
    const bytes = await readFile(path);
    return bytes.length === want.bytes && sha256(bytes) === want.sha256;
  } catch {
    return false;
  }
}

export async function fetchModels(dest) {
  const manifestBytes = await download(`${RAW}/manifest.json`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.format !== 'zen-tts-models' || !manifest.files) throw new Error('unexpected upstream manifest');
  await mkdir(dest, { recursive: true });
  let fetched = 0;
  for (const [rel, want] of Object.entries(manifest.files)) {
    const path = join(dest, rel);
    if (await existingMatches(path, want)) continue;
    const bytes = await download(`${RAW}/${rel}`);
    if (bytes.length !== want.bytes || sha256(bytes) !== want.sha256) {
      throw new Error(`${rel}: sha256 or size does not match upstream manifest`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
    fetched++;
  }
  await writeFile(join(dest, 'manifest.json'), manifestBytes);
  return { files: Object.keys(manifest.files).length, fetched };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = resolve(process.argv[2] ?? process.env.ZEN_TTS_MODELS ?? 'models');
  const { files, fetched } = await fetchModels(dest);
  console.log(`models ok: ${files} files verified in ${dest} (${fetched} downloaded)`);
}
