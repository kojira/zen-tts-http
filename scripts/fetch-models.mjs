// Download the ZEN-TTS 1.1.0 voices (one .ztm file per voice) from the upstream CDN and check each
// against the sha256 that upstream publishes in its README (table "モデルファイル").
//
// The weights are not part of this repository and are never redistributed (ZEN-TTS License,
// section 3.3). Each machine fetches them from Zenryoku Kikai's CDN itself. The G2P ships inside
// the zen-tts package (models/g2p/), so nothing else is downloaded.
//
//   node scripts/fetch-models.mjs [dest]      (default: ZEN_TTS_MODELS or ./models)
//
// Result: <dest>/<id>.ztm for marine, hashiro, kai, kikka, and <dest>/voices.json.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep in sync with the zen-tts dependency in package.json (v1.1.0).
export const ZTM_BASE_URL = 'https://tts-models.zenryoku.work/v1.1.0/';

// Copied from the upstream README (v1.1.0), table "モデルファイル".
export const BUILTIN_VOICES = {
  marine: {
    name: { ja: '全力 マリン', en: 'Zenryoku Marine' },
    model: 'marine-1.0',
    sha256: '3fce81efbbb598b546429c6e53955a6d18fdbc9bca72afd029baf2eac06678a0',
  },
  hashiro: {
    name: { ja: '全力 ハシロウ', en: 'Zenryoku Hashiro' },
    model: 'hashiro-1.0',
    sha256: 'ad6557b1d5e427c3466203a6b450530b70480b4a825129c734322de39d269230',
  },
  kai: {
    name: { ja: '全力 カイ', en: 'Zenryoku Kai' },
    model: 'kai-1.0',
    sha256: '653d1c14b6eff80a0d28e483422a43ad82c3b78f8ead61cb7aa1984062883e33',
  },
  kikka: {
    name: { ja: '全力 キッカ', en: 'Zenryoku Kikka' },
    model: 'kikka-1.0',
    sha256: '1875058d12bf15815638542e8b1178af56f63ca29120b5c7f5b97d38e4cc5c17',
  },
};
export const DEFAULT_VOICE = 'marine';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function existingMatches(path, want) {
  try {
    return sha256(await readFile(path)) === want;
  } catch {
    return false;
  }
}

export async function fetchModels(dest) {
  await mkdir(dest, { recursive: true });
  let fetched = 0;
  for (const [id, voice] of Object.entries(BUILTIN_VOICES)) {
    const path = join(dest, `${id}.ztm`);
    if (await existingMatches(path, voice.sha256)) continue;
    const url = `${ZTM_BASE_URL}${id}.ztm`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sha256(bytes) !== voice.sha256) throw new Error(`${id}.ztm: sha256 does not match the upstream README`);
    await writeFile(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
    fetched++;
  }
  const catalogue = {
    default: DEFAULT_VOICE,
    voices: Object.fromEntries(
      Object.entries(BUILTIN_VOICES).map(([id, v]) => [id, { id, name: v.name, model: v.model, file: `${id}.ztm` }]),
    ),
  };
  await writeFile(join(dest, 'voices.json'), JSON.stringify(catalogue, null, 2));
  return { files: Object.keys(BUILTIN_VOICES).length, fetched };
}

// Compare real paths: the script may be reached through a symlink or a path with spaces.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const dest = resolve(process.argv[2] ?? process.env.ZEN_TTS_MODELS ?? 'models');
  const { files, fetched } = await fetchModels(dest);
  console.log(`models ok: ${files} voices verified in ${dest} (${fetched} downloaded)`);
}
