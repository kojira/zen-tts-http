import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';

const modelsPath = resolve(process.env.ZEN_TTS_MODELS ?? 'models');
const haveModels = existsSync(resolve(modelsPath, 'manifest.json'));
const skip = haveModels ? false : `models are missing at ${modelsPath}; run "pnpm fetch-models" first`;

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

// The test upload is an upstream voice's own files (kikka), as a custom voice would arrive.
function voiceForm({ id, files = {} }) {
  const form = new FormData();
  form.set('id', id);
  form.set('name_ja', 'テストの声');
  form.set('name_en', 'Test voice');
  const source = join(modelsPath, 'voices', 'kikka');
  const parts = {
    own_bin: ['tts/own.bin'],
    own_json: ['tts/own.json'],
    nsf_bin: ['decoder/nsf.bin'],
    nsf_json: ['decoder/nsf.json'],
  };
  for (const [name, [path]] of Object.entries(parts)) {
    const data = files[name] ?? readFileSync(join(source, path));
    form.set(name, new Blob([data]), path.split('/').pop());
  }
  return form;
}

const addVoice = (form) => fetch(`${base}/voices`, { method: 'POST', body: form });
const customEntries = () => (existsSync(join(dataPath, 'custom')) ? readdirSync(join(dataPath, 'custom')) : []);

test('GET / is the settings page with the viewport meta and the ZEN-TTS credit link', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /音声合成：<a href="https:\/\/zenryokukikai\.com"[^>]*>ZEN-TTS（https:\/\/zenryokukikai\.com ）<\/a>/);
});

test('a valid custom voice is added, listed, synthesized and deleted', { skip }, async () => {
  const res = await addVoice(voiceForm({ id: 'my-voice' }));
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual((await res.json()).voice, { id: 'my-voice', name: { ja: 'テストの声', en: 'Test voice' }, custom: true });

  const list = await (await fetch(`${base}/voices`)).json();
  const ids = list.voices.map((v) => `${v.id}:${v.custom}`);
  assert.ok(ids.includes('my-voice:true'), ids.join(','));
  assert.ok(ids.includes('marine:false'), ids.join(','));

  const wav = await fetch(`${base}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'こんにちは', voice: 'my-voice' }),
  });
  assert.equal(wav.status, 200);
  const bytes = Buffer.from(await wav.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(24), 44100);

  const del = await fetch(`${base}/voices/my-voice`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(customEntries(), []);
  const after = await (await fetch(`${base}/voices`)).json();
  assert.ok(!after.voices.some((v) => v.id === 'my-voice'));
  const gone = await fetch(`${base}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'こんにちは', voice: 'my-voice' }),
  });
  assert.equal(gone.status, 400);
});

test('an upload whose files cannot be loaded is refused with 400 and leaves nothing behind', { skip }, async () => {
  const bad = await addVoice(voiceForm({ id: 'broken', files: { own_bin: Buffer.from('not a model') } }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /読み込めません/);
  assert.deepEqual(customEntries(), []);

  const badJson = await addVoice(voiceForm({ id: 'broken', files: { nsf_json: Buffer.from('{not json') } }));
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error, /JSON/);
  assert.deepEqual(customEntries(), []);
});

test('an id that is a built-in voice or malformed is rejected', { skip }, async () => {
  for (const id of ['marine', 'Bad_Id', 'x']) {
    const res = await addVoice(voiceForm({ id }));
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
