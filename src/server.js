// HTTP API for ZEN-TTS (zenryokukikai/zen-tts). Uses only node:http.
//
//   GET  /health      -> {"ok":true}
//   GET  /voices      -> {"default":"marine","voices":[{"id","name":{"ja","en"}}],"emotions":[...]}
//   POST /synthesize  {"text","voice"?,"emotion"?,"strength"?} -> audio/wav (44.1 kHz, mono)
//
// Errors are JSON {"error": "..."} with status 400 (bad request), 404 (unknown path) or 500.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZenTtsNode, wavBytes, emotionNames } from 'zen-tts/node';

export const MAX_TEXT_CHARS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

export function createApp({ modelsPath }) {
  const voicesByDefault = loadManifest(modelsPath);
  const loaded = new Map();

  function engine(voice) {
    // Load each voice once, on first use, and keep it.
    if (!loaded.has(voice)) {
      const promise = ZenTtsNode.load({ modelsPath, voice });
      promise.catch(() => loaded.delete(voice));
      loaded.set(voice, promise);
    }
    return loaded.get(voice);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/voices') {
      const manifest = await voicesByDefault;
      return sendJson(res, 200, {
        default: manifest.default,
        voices: Object.values(manifest.voices).map((v) => ({ id: v.id, name: v.name })),
        emotions: [...emotionNames],
      });
    }
    if (req.method === 'POST' && url.pathname === '/synthesize') {
      const body = await readJson(req);
      const manifest = await voicesByDefault;
      const request = validate(body, manifest);
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

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof BadRequest ? 400 : 500;
      if (status === 500) console.error('synthesis failed:', error);
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.destroy();
    });
  });
}

class BadRequest extends Error {}

async function loadManifest(modelsPath) {
  const text = await readFile(join(modelsPath, 'manifest.json'), 'utf8');
  return JSON.parse(text);
}

function validate(body, manifest) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('body must be a JSON object');
  }
  const { text, voice = manifest.default, emotion, strength } = body;
  if (typeof text !== 'string' || text.trim() === '') throw new BadRequest('text must be a non-empty string');
  if ([...text].length > MAX_TEXT_CHARS) throw new BadRequest(`text must be at most ${MAX_TEXT_CHARS} characters`);
  if (typeof voice !== 'string' || !(voice in manifest.voices)) {
    throw new BadRequest(`unknown voice: ${String(voice)} (one of ${Object.keys(manifest.voices).join(', ')})`);
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
