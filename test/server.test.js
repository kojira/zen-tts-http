import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/server.js';

const modelsPath = resolve(process.env.ZEN_TTS_MODELS ?? 'models');
const haveModels = existsSync(resolve(modelsPath, 'voices.json'));
const skip = haveModels ? false : `models are missing at ${modelsPath}; run "pnpm fetch-models" first`;

let server;
let base;

before(async () => {
  if (!haveModels) return;
  server = createApp({ modelsPath });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function post(body) {
  return fetch(`${base}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('GET /health reports zen-tts 1.1.0 and each voice model', { skip }, async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, '1.1.0');
  assert.deepEqual(body.models, { marine: 'marine-1.0', hashiro: 'hashiro-1.0', kai: 'kai-1.0', kikka: 'kikka-1.0' });
});

test('GET /voices lists the four voices and the emotion keys', { skip }, async () => {
  const body = await (await fetch(`${base}/voices`)).json();
  assert.equal(body.default, 'marine');
  assert.deepEqual(body.voices.map((v) => v.id).sort(), ['hashiro', 'kai', 'kikka', 'marine']);
  assert.ok(body.voices.every((v) => v.name.ja && v.name.en));
  assert.deepEqual(body.emotions, ['neutral', 'happy', 'sad', 'angry', 'apologetic']);
});

test('POST /synthesize returns a 44.1 kHz mono WAV from a built-in .ztm', { skip }, async () => {
  const res = await post({ text: 'こんにちは', voice: 'kikka', emotion: { happy: 70, neutral: 30 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  const wav = Buffer.from(await res.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 44100, 'sample rate');
  assert.ok(wav.length > 1000, 'has audio');
});

test('POST /synthesize rejects bad input with 400 and a JSON error', { skip }, async () => {
  const cases = [
    'not json',
    { text: '' },
    { text: 'あ'.repeat(1001) },
    { text: 'あ', voice: 'nobody' },
    { text: 'あ', emotion: { happy: 101 } },
    { text: 'あ', emotion: { joy: 10 } },
    { text: 'あ', strength: -1 },
  ];
  for (const body of cases) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(typeof (await res.json()).error, 'string');
  }
});

async function pcm(body) {
  const res = await post(body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  return Buffer.from(await res.arrayBuffer()).subarray(44);
}

test('POST /synthesize reads a word as the dict entry says (reading and accent)', { skip }, async () => {
  const plain = await pcm({ text: '明日', voice: 'marine' });
  const withDict = await pcm({ text: '明日', voice: 'marine', dict: [{ surface: '明日', reading: 'アス', accent: 2 }] });
  assert.notDeepEqual(withDict, plain);
  const export_ = { text: '明日', voice: 'marine', dict: [{ surface: '明日', reading: 'アス', accent: 2 }], settings: { accentHeight: 6 } };
  assert.notDeepEqual(await pcm(export_), withDict, 'settings.accentHeight is applied');
});

test('POST /synthesize rejects a bad dict with 400 and a JSON error', { skip }, async () => {
  const cases = [
    { dict: { surface: '明日', reading: 'アス' } },
    { dict: [{ reading: 'アス' }] },
    { dict: [{ surface: '明日', reading: 'asu' }] },
    { dict: [{ surface: '明日', reading: 'アス', accent: -1 }] },
    { dict: [{ surface: '明日', reading: 'アス', phrase: 'cut' }] },
    { dict: [{ surface: '明日', reading: 'アス', contour: [4] }] },
    { dict: [{ surface: '明日', reading: 'アス', length: [0] }] },
    { dict: [{ surface: '明日', reading: 'アス', color: 'red' }] },
    { dict: Array.from({ length: 2001 }, () => ({ surface: 'あ', reading: 'ア' })) },
    { settings: { accentHeight: 'high' } },
  ];
  for (const extra of cases) {
    const res = await post({ text: '明日', ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra).slice(0, 60));
    assert.equal(typeof (await res.json()).error, 'string');
  }
});

test('unknown paths are 404', { skip }, async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
