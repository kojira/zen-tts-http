// HTTP API and settings page for ZEN-TTS (zenryokukikai/zen-tts). Uses only node built-ins.
//
//   GET    /                 -> the settings page (HTML)
//   GET    /health           -> {"ok":true,"version":"<zen-tts version>","models":{"<voice>":"<model>"}}
//   GET    /voices           -> {"default":"marine","voices":[{"id","name":{"ja","en"},"custom"}],"emotions":[...]}
//   POST   /voices           multipart: id, name_ja, name_en, own_bin, own_json, nsf_bin, nsf_json -> 201 {voice}
//   DELETE /voices/{id}      custom voices only -> {"deleted":"<id>"}
//   POST   /synthesize       {"text","voice"?,"emotion"?,"strength"?} -> audio/wav (44.1 kHz, mono)
//
// Errors are JSON {"error": "..."} with status 400, 404, 409, 413 or 500.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ZenTtsNode, wavBytes, emotionNames, VERSION } from 'zen-tts/node';
import { boundaryOf, readBody, parseMultipart, MultipartError } from './multipart.js';
import { loadBuiltin, listCustom, stageCustom, commitCustom, discard, customDir, CUSTOM_ID, VoiceError } from './voices.js';

export const MAX_TEXT_CHARS = 1000;
const MAX_BODY_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * MAX_FILE_BYTES + 1024 * 1024;

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

export function createHandler({ modelsPath, dataPath }) {
  const builtin = loadBuiltin(modelsPath);
  const loaded = new Map();

  function load(key, options) {
    // Load each voice once, on first use, and keep it.
    if (!loaded.has(key)) {
      const promise = ZenTtsNode.load(options);
      promise.catch(() => loaded.delete(key));
      loaded.set(key, promise);
    }
    return loaded.get(key);
  }

  async function catalogue() {
    const manifest = await builtin;
    const custom = await listCustom(dataPath);
    return { manifest, builtinIds: Object.keys(manifest.voices), custom };
  }

  async function engine(voice) {
    const { builtinIds, custom } = await catalogue();
    if (builtinIds.includes(voice)) return load(`builtin:${voice}`, { modelsPath, voice });
    if (custom.some((v) => v.id === voice)) {
      return load(`custom:${voice}`, { modelsPath: customDir(dataPath, voice), voice: 'marine' });
    }
    throw new BadRequest(`unknown voice: ${voice} (one of ${[...builtinIds, ...custom.map((v) => v.id)].join(', ')})`);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(PAGE) });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      // version + models identify the audio a request produces; clients use them to drop caches.
      // A custom voice is identified by when it was added (replacing it means delete + add).
      const { manifest, custom } = await catalogue();
      const models = Object.fromEntries([
        ...Object.values(manifest.voices).map((v) => [v.id, v.model]),
        ...custom.map((v) => [v.id, `custom-${v.added_at}`]),
      ]);
      return sendJson(res, 200, { ok: true, version: VERSION, models });
    }
    if (req.method === 'GET' && url.pathname === '/voices') {
      const { manifest, custom } = await catalogue();
      return sendJson(res, 200, {
        default: manifest.default,
        voices: [
          ...Object.values(manifest.voices).map((v) => ({ id: v.id, name: v.name, custom: false })),
          ...custom.map((v) => ({ id: v.id, name: v.name, custom: true })),
        ],
        emotions: [...emotionNames],
      });
    }
    if (req.method === 'POST' && url.pathname === '/voices') {
      if (!dataPath) throw new BadRequest('custom voices are disabled (ZEN_TTS_DATA is not set)');
      return addVoice(req, res);
    }
    const deleteMatch = /^\/voices\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      const { builtinIds, custom } = await catalogue();
      if (builtinIds.includes(id)) throw new BadRequest(`組み込みの声 "${id}" は削除できません`);
      if (!custom.some((v) => v.id === id)) return sendJson(res, 404, { error: `unknown custom voice: ${id}` });
      loaded.delete(`custom:${id}`);
      await discard(customDir(dataPath, id));
      return sendJson(res, 200, { deleted: id });
    }
    if (req.method === 'POST' && url.pathname === '/synthesize') {
      const body = await readJson(req);
      const request = validate(body, (await builtin).default);
      const tts = await engine(request.voice);
      const options = {};
      if (request.emotion) options.emotion = request.emotion;
      if (request.strength !== undefined) options.strength = request.strength;
      const result = await tts.speak(request.text, options);
      const wav = wavBytes(result.pcm, result.sampleRate);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
      return res.end(wav);
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  async function addVoice(req, res) {
    const boundary = boundaryOf(req.headers['content-type']);
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const { fields, files } = parseMultipart(body, boundary);
    const { builtinIds, custom } = await catalogue();
    const staged = await stageCustom(dataPath, builtinIds, fields, files, MAX_FILE_BYTES);
    try {
      if (custom.some((v) => v.id === staged.id)) {
        throw new Conflict(`id "${staged.id}" の声はもうあります（差し替えるときは先に削除してください）`);
      }
      // Load it before keeping it: a set of files the engine cannot load is refused.
      const tts = await ZenTtsNode.load({ modelsPath: staged.staging, voice: 'marine' }).catch((error) => {
        throw new BadRequest(`この声を読み込めません: ${error.message}`);
      });
      await commitCustom(staged);
      loaded.set(`custom:${staged.id}`, Promise.resolve(tts));
    } catch (error) {
      await discard(staged.staging);
      throw error;
    }
    return sendJson(res, 201, { voice: { id: staged.meta.id, name: staged.meta.name, custom: true } });
  }

  return (req, res) => {
    handle(req, res).catch((error) => {
      const status =
        error instanceof BadRequest || error instanceof VoiceError || error instanceof MultipartError
          ? error.message.includes('too large') ? 413 : 400
          : error instanceof Conflict ? 409 : 500;
      if (status === 500) console.error('request failed:', error);
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.destroy();
    });
  };
}

// One app (one voice cache), served on any number of listeners: the API port and an optional admin port.
export function createApp(options) {
  return createServer(createHandler(options));
}

class BadRequest extends Error {}
class Conflict extends Error {}

function validate(body, defaultVoice) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('body must be a JSON object');
  }
  const { text, voice = defaultVoice, emotion, strength } = body;
  if (typeof text !== 'string' || text.trim() === '') throw new BadRequest('text must be a non-empty string');
  if ([...text].length > MAX_TEXT_CHARS) throw new BadRequest(`text must be at most ${MAX_TEXT_CHARS} characters`);
  if (typeof voice !== 'string' || !CUSTOM_ID.test(voice)) {
    throw new BadRequest(`unknown voice: ${String(voice)}`);
  }
  let checkedEmotion;
  if (emotion !== undefined) {
    if (emotion === null || typeof emotion !== 'object' || Array.isArray(emotion)) {
      throw new BadRequest('emotion must be an object');
    }
    checkedEmotion = {};
    for (const [key, value] of Object.entries(emotion)) {
      if (!emotionNames.includes(key)) throw new BadRequest(`unknown emotion: ${key} (one of ${emotionNames.join(', ')})`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new BadRequest(`emotion.${key} must be a number from 0 to 100`);
      }
      checkedEmotion[key] = value;
    }
  }
  if (strength !== undefined && (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0)) {
    throw new BadRequest('strength must be a non-negative number');
  }
  return { text, voice, emotion: checkedEmotion, strength };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body must be JSON');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

