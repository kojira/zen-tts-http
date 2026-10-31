// Voice catalogue: the built-in voices of the upstream models directory, plus custom voices that
// live each in their own directory in the built-in "marine" layout:
//
//   <dataPath>/custom/<id>/tts/own.bin, tts/own.json, decoder/nsf.bin, decoder/nsf.json
//   <dataPath>/custom/<id>/voice.json   {id, name: {ja, en}, added_at}
//
// A custom voice is loaded with ZenTtsNode.load({modelsPath: <its dir>, voice: 'marine'}), so the
// upstream package is used as it is (its licence forbids modifying it).

import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const UPLOAD_FILES = {
  own_bin: 'tts/own.bin',
  own_json: 'tts/own.json',
  nsf_bin: 'decoder/nsf.bin',
  nsf_json: 'decoder/nsf.json',
};

export class VoiceError extends Error {}

export async function loadBuiltin(modelsPath) {
  const manifest = JSON.parse(await readFile(join(modelsPath, 'manifest.json'), 'utf8'));
  return manifest;
}

export function customDir(dataPath, id) {
  return join(dataPath, 'custom', id);
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

// Validates the form and writes the files to a staging directory, returning it. The caller loads
// the voice from there and then calls commitCustom or discards the staging directory.
export async function stageCustom(dataPath, builtinIds, fields, files, maxFileBytes) {
  const id = (fields.id ?? '').trim();
  if (!CUSTOM_ID.test(id)) throw new VoiceError('id は英小文字・数字・ハイフンで 2〜32 文字（先頭は英小文字か数字）にしてください');
  if (builtinIds.includes(id)) throw new VoiceError(`id "${id}" は組み込みの声と同じです`);
  const nameJa = (fields.name_ja ?? '').trim();
  const nameEn = (fields.name_en ?? '').trim();
  if (!nameJa) throw new VoiceError('name_ja（日本語の名前）が空です');
  if ([...nameJa].length > 64 || [...nameEn].length > 64) throw new VoiceError('名前は 64 文字までです');
  for (const key of Object.keys(UPLOAD_FILES)) {
    const file = files[key];
    if (!file || file.data.length === 0) throw new VoiceError(`${key} のファイルがありません`);
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
  const finalDir = customDir(dataPath, id);
  const staging = join(dataPath, 'custom', `.staging-${id}-${process.pid}-${Date.now()}`);
  await mkdir(join(staging, 'tts'), { recursive: true });
  await mkdir(join(staging, 'decoder'), { recursive: true });
  for (const [key, path] of Object.entries(UPLOAD_FILES)) {
    await writeFile(join(staging, path), files[key].data, { mode: 0o600 });
  }
  const meta = { id, name: { ja: nameJa, en: nameEn || nameJa }, added_at: new Date().toISOString() };
  return { id, meta, staging, finalDir };
}

export async function commitCustom({ meta, staging, finalDir }) {
  await writeFile(join(staging, 'voice.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  await rename(staging, finalDir);
}

export async function discard(path) {
  await rm(path, { recursive: true, force: true });
}
