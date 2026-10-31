import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';

const modelsPath = resolve(process.env.ZEN_TTS_MODELS ?? 'models');
const haveModels = existsSync(resolve(modelsPath, 'voices.json'));
const skip = haveModels ? false : `models are missing at ${modelsPath}; run "pnpm fetch-models" first`;
// The 1.0.0 four-file layout of kikka (upstream tag v1.0.0, models/voices/kikka). Not downloaded by
// fetch-models any more; point ZEN_TTS_MODELS_V100 at a v1.0.0 models/ directory to run that test.
const legacyPath = process.env.ZEN_TTS_MODELS_V100 ? resolve(process.env.ZEN_TTS_MODELS_V100) : undefined;
const legacySource = legacyPath && join(legacyPath, 'voices', 'kikka');
const skipLegacy = !haveModels
  ? skip
  : legacySource && existsSync(join(legacySource, 'tts', 'own.bin'))
    ? false
    : 'ZEN_TTS_MODELS_V100 is not set to a v1.0.0 models/ directory (upstream tag v1.0.0); the 1.0.0 files are not fetched any more';

let server;
let base;
let dataPath;

before(async () => {
  dataPath = mkdtempSync(join(tmpdir(), 'zen-tts-data-'));
  server = createApp({ modelsPath, dataPath });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dataPath, { recursive: true, force: true });
});

function names(form, id) {
  form.set('id', id);
  form.set('name_ja', 'テストの声');
  form.set('name_en', 'Test voice');
  return form;
}

// A .ztm upload: by default a copy of the fetched built-in kikka voice, as a custom voice would arrive.
function ztmForm({ id, data }) {
  const form = names(new FormData(), id);
  form.set('ztm', new Blob([data ?? readFileSync(join(modelsPath, 'kikka.ztm'))]), 'voice.ztm');
  return form;
}

function legacyForm({ id }) {
  const form = names(new FormData(), id);
  const parts = { own_bin: 'tts/own.bin', own_json: 'tts/own.json', nsf_bin: 'decoder/nsf.bin', nsf_json: 'decoder/nsf.json' };
  for (const [name, path] of Object.entries(parts)) {
    form.set(name, new Blob([readFileSync(join(legacySource, path))]), path.split('/').pop());
  }
  return form;
}

const addVoice = (form) => fetch(`${base}/voices`, { method: 'POST', body: form });
const customEntries = () => (existsSync(join(dataPath, 'custom')) ? readdirSync(join(dataPath, 'custom')) : []);
const synthesize = (voice) =>
  fetch(`${base}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'こんにちは', voice }),
  });

async function assertWav(res) {
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(24), 44100);
}

test('GET / is the settings page: viewport, credit link, .ztm upload with the 1.0.0 toggle', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /音声合成：<a href="https:\/\/zenryokukikai\.com"[^>]*>ZEN-TTS（https:\/\/zenryokukikai\.com ）<\/a>/);
  assert.match(html, /name="ztm" accept="\.ztm"/);
  assert.match(html, /id="a-legacy"/);
});

test('a custom .ztm voice is added, stored as voice.ztm, synthesized and deleted', { skip }, async () => {
  const res = await addVoice(ztmForm({ id: 'my-voice' }));
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual((await res.json()).voice, { id: 'my-voice', name: { ja: 'テストの声', en: 'Test voice' }, custom: true });
  assert.deepEqual(readdirSync(join(dataPath, 'custom', 'my-voice')).sort(), ['voice.json', 'voice.ztm']);
  assert.equal(JSON.parse(readFileSync(join(dataPath, 'custom', 'my-voice', 'voice.json'), 'utf8')).format, 'ztm');

  const list = await (await fetch(`${base}/voices`)).json();
  const ids = list.voices.map((v) => `${v.id}:${v.custom}`);
  assert.ok(ids.includes('my-voice:true'), ids.join(','));
  assert.ok(ids.includes('marine:false'), ids.join(','));
  await assertWav(await synthesize('my-voice'));

  // A fresh server (empty engine cache) loads the stored .ztm from disk.
  const second = createApp({ modelsPath, dataPath });
  await new Promise((done) => second.listen(0, '127.0.0.1', done));
  try {
    await assertWav(
      await fetch(`http://127.0.0.1:${second.address().port}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'こんにちは', voice: 'my-voice' }),
      }),
    );
  } finally {
    second.close();
  }

  const del = await fetch(`${base}/voices/my-voice`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(customEntries(), []);
  assert.equal((await synthesize('my-voice')).status, 400);
});

test('a custom voice in the 1.0.0 four-file layout is still added and synthesized', { skip: skipLegacy }, async () => {
  const res = await addVoice(legacyForm({ id: 'old-voice' }));
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(JSON.parse(readFileSync(join(dataPath, 'custom', 'old-voice', 'voice.json'), 'utf8')).format, 'legacy-1.0.0');
  await assertWav(await synthesize('old-voice'));
  assert.equal((await fetch(`${base}/voices/old-voice`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(customEntries(), []);
});

test('a bad .ztm is refused with 400 and leaves nothing behind', { skip }, async () => {
  const bad = await addVoice(ztmForm({ id: 'broken', data: Buffer.from('not a model') }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /読み込めません/);
  assert.deepEqual(customEntries(), []);

  const nothing = await addVoice(names(new FormData(), 'empty'));
  assert.equal(nothing.status, 400);
  assert.match((await nothing.json()).error, /\.ztm/);
  assert.deepEqual(customEntries(), []);
});

test('an id that is a built-in voice or malformed is rejected', { skip }, async () => {
  for (const id of ['marine', 'Bad_Id', 'x']) {
    const res = await addVoice(ztmForm({ id }));
    assert.equal(res.status, 400, id);
  }
  assert.deepEqual(customEntries(), []);
});

test('a built-in voice cannot be deleted', { skip }, async () => {
  const res = await fetch(`${base}/voices/marine`, { method: 'DELETE' });
  assert.equal(res.status, 400);
  const list = await (await fetch(`${base}/voices`)).json();
  assert.ok(list.voices.some((v) => v.id === 'marine'));
});
