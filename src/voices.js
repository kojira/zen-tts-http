// Voice catalogue: the built-in voices (one .ztm each, fetched by scripts/fetch-models.mjs), plus
// custom voices. A custom voice is stored in one of two layouts:
//
//   1.1.0 (default):  <dataPath>/custom/<id>/voice.ztm
//   1.0.0 (older):    <dataPath>/custom/<id>/tts/own.bin, tts/own.json, decoder/nsf.bin, decoder/nsf.json
//   both:             <dataPath>/custom/<id>/voice.json   {id, name: {ja, en}, added_at, format}
//
// Loading uses the upstream package as it is (its licence forbids modifying it):
//   .ztm   -> ZenTtsNode.load({model: <path to the .ztm>})
//   1.0.0  -> ZenTtsNode.load({modelsPath: <its dir>, voice: 'marine'})

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
// The 1.0.0 layout: one upload field per file.
export const LEGACY_UPLOAD_FILES = {
  own_bin: 'tts/own.bin',
  own_json: 'tts/own.json',
  nsf_bin: 'decoder/nsf.bin',
  nsf_json: 'decoder/nsf.json',
};
export const ZTM_FILE = 'voice.ztm';

export class VoiceError extends Error {}

// The built-in catalogue written by fetch-models: {default, voices: {<id>: {id, name, model, file}}}.
export async function loadBuiltin(modelsPath) {
  return JSON.parse(await readFile(join(modelsPath, 'voices.json'), 'utf8'));
}

export function customDir(dataPath, id) {
  return join(dataPath, 'custom', id);
}

// The ZenTtsNode.load options for a stored custom voice.
export function customLoadOptions(dataPath, id) {
  const dir = customDir(dataPath, id);
  const ztm = join(dir, ZTM_FILE);
  return existsSync(ztm) ? { model: ztm } : { modelsPath: dir, voice: 'marine' };
}

export async function listCustom(dataPath) {
  if (!dataPath) return [];
  let entries;
  try {
    entries = await readdir(join(dataPath, 'custom'), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const voices = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CUSTOM_ID.test(entry.name)) continue;
    try {
      const meta = JSON.parse(await readFile(join(dataPath, 'custom', entry.name, 'voice.json'), 'utf8'));
      if (meta.id === entry.name) voices.push(meta);
    } catch {
      // A directory without readable metadata (e.g. an upload that is still being written) is not a voice.
    }
  }
  return voices.sort((a, b) => a.id.localeCompare(b.id));
}

// Validates the form and writes the files to a staging directory. Returns the staging info plus the
// ZenTtsNode.load options to try; the caller loads it and then calls commitCustom or discards it.
// A `ztm` file selects the 1.1.0 layout; otherwise the four 1.0.0 files are required.
export async function stageCustom(dataPath, builtinIds, fields, files, maxFileBytes) {
  const id = (fields.id ?? '').trim();
  if (!CUSTOM_ID.test(id)) throw new VoiceError('id は英小文字・数字・ハイフンで 2〜32 文字（先頭は英小文字か数字）にしてください');
  if (builtinIds.includes(id)) throw new VoiceError(`id "${id}" は組み込みの声と同じです`);
  const nameJa = (fields.name_ja ?? '').trim();
  const nameEn = (fields.name_en ?? '').trim();
  if (!nameJa) throw new VoiceError('name_ja（日本語の名前）が空です');
  if ([...nameJa].length > 64 || [...nameEn].length > 64) throw new VoiceError('名前は 64 文字までです');

  const ztm = files.ztm && files.ztm.data.length > 0 ? files.ztm : undefined;
  const format = ztm ? 'ztm' : 'legacy-1.0.0';
  if (ztm) {
    if (ztm.data.length > maxFileBytes) throw new VoiceError(`ztm が大きすぎます（${maxFileBytes} バイトまで）`);
  } else {
    for (const key of Object.keys(LEGACY_UPLOAD_FILES)) {
      const file = files[key];
      if (!file || file.data.length === 0) {
        throw new VoiceError(`.ztm ファイル（ztm）か、1.0.0 の 4 ファイルを送ってください（${key} がありません）`);
      }
      if (file.data.length > maxFileBytes) throw new VoiceError(`${key} が大きすぎます（1 ファイル ${maxFileBytes} バイトまで）`);
    }
    for (const key of ['own_json', 'nsf_json']) {
      try {
        const value = JSON.parse(files[key].data.toString('utf8'));
        if (value === null || typeof value !== 'object') throw new Error('not an object');
      } catch (error) {
        throw new VoiceError(`${key} が JSON として読めません: ${error.message}`);
      }
    }
  }

  const finalDir = customDir(dataPath, id);
  const staging = join(dataPath, 'custom', `.staging-${id}-${process.pid}-${Date.now()}`);
  let loadOptions;
  if (ztm) {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, ZTM_FILE), ztm.data, { mode: 0o600 });
    loadOptions = { model: join(staging, ZTM_FILE) };
  } else {
    await mkdir(join(staging, 'tts'), { recursive: true });
    await mkdir(join(staging, 'decoder'), { recursive: true });
    for (const [key, path] of Object.entries(LEGACY_UPLOAD_FILES)) {
      await writeFile(join(staging, path), files[key].data, { mode: 0o600 });
    }
    loadOptions = { modelsPath: staging, voice: 'marine' };
  }
  const meta = { id, name: { ja: nameJa, en: nameEn || nameJa }, added_at: new Date().toISOString(), format };
  return { id, meta, staging, finalDir, loadOptions };
}

export async function commitCustom({ meta, staging, finalDir }) {
  await writeFile(join(staging, 'voice.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  await rename(staging, finalDir);
}

export async function discard(path) {
  await rm(path, { recursive: true, force: true });
}
