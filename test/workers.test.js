import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, SPEED_RANGE } from '../src/server.js';
import { workerCount } from '../src/engines.js';
import * as zenTts from 'zen-tts/node';

const modelsPath = resolve(process.env.ZEN_TTS_MODELS ?? 'models');
const haveModels = existsSync(resolve(modelsPath, 'voices.json'));
const skip = haveModels ? false : `models are missing at ${modelsPath}; run "pnpm fetch-models" first`;

let one;
let many;
let dataPath;

async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

before(async () => {
  if (!haveModels) return;
  dataPath = mkdtempSync(join(tmpdir(), 'zen-tts-workers-'));
  one = await listen(createApp({ modelsPath }));
  many = await listen(createApp({ modelsPath, dataPath, workers: 2 }));
});

after(() => {
  one?.server.close();
  many?.server.close();
  if (dataPath) rmSync(dataPath, { recursive: true, force: true });
});

const post = (base, path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('ZEN_TTS_WORKERS: unset is 1, auto is the cores, other values are refused', () => {
  assert.equal(workerCount(undefined), 1);
  assert.equal(workerCount(''), 1);
  assert.equal(workerCount('4'), 4);
  assert.ok(workerCount('auto') >= 1);
  for (const bad of ['0', '-1', '1.5', 'many', '257']) assert.throws(() => workerCount(bad), /ZEN_TTS_WORKERS/);
});

test('/synthesize returns the same WAV bytes as zen-tts in one process, with 1 and with 2 workers', { skip }, async () => {
  const bodies = [
    { text: 'こんにちは', voice: 'kikka', emotion: { happy: 70, neutral: 30 } },
    { text: '明日', voice: 'marine', dict: [{ surface: '明日', reading: 'アス', accent: 2 }] },
    // speed only where the installed zen-tts has it (1.3.0 on)
    { text: '今日はいい天気ですね。', voice: 'hashiro', ...(SPEED_RANGE ? { speed: SPEED_RANGE.max } : {}) },
  ];
  const manifest = JSON.parse(readFileSync(join(modelsPath, 'voices.json'), 'utf8'));
  for (const body of bodies) {
    // the reference: zen-tts called directly, as the server did before it had workers
    const tts = await zenTts.ZenTtsNode.load({ model: join(modelsPath, manifest.voices[body.voice].file) });
    const { text, voice, ...options } = body;
    const result = await tts.speak(text, options);
    const expected = Buffer.from(zenTts.wavBytes(result.pcm, result.sampleRate));
    for (const { base } of [one, many]) {
      const res = await post(base, '/synthesize', body);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'audio/wav');
      assert.ok(expected.equals(Buffer.from(await res.arrayBuffer())), JSON.stringify(body).slice(0, 40));
    }
  }
});

test('with workers, concurrent requests all succeed and errors stay JSON 400', { skip }, async () => {
  const texts = ['ありがとうございます。', 'こちらへどうぞ。', '少々お待ちください。', 'またお越しください。'];
  const results = await Promise.all(texts.flatMap((text) => [post(many.base, '/synthesize', { text, voice: 'kai' }), post(many.base, '/synthesize', { text, voice: 'marine' })]));
  for (const res of results) assert.equal(res.status, 200);
  const analyze = await post(many.base, '/analyze', { text: '明日', voice: 'marine' });
  assert.equal(analyze.status, 200);
  assert.equal(typeof (await analyze.json()).reading, 'string');
  const bad = await post(many.base, '/analyze', { text: '。', voice: 'marine' });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error, 'string');
});

test('with workers, an added voice is used by every worker and is gone after delete', { skip }, async () => {
  const form = new FormData();
  form.set('id', 'my-kikka');
  form.set('name_ja', 'テストの声');
  form.set('ztm', new Blob([readFileSync(join(modelsPath, 'kikka.ztm'))]), 'voice.ztm');
  assert.equal((await fetch(`${many.base}/voices`, { method: 'POST', body: form })).status, 201);
  // Two at once: both workers serve the new voice (one loads it from ZEN_TTS_DATA).
  const pair = await Promise.all([1, 2].map(() => post(many.base, '/synthesize', { text: 'こんにちは', voice: 'my-kikka' })));
  for (const res of pair) assert.equal(res.status, 200);
  assert.equal((await fetch(`${many.base}/voices/my-kikka`, { method: 'DELETE' })).status, 200);
  const gone = await post(many.base, '/synthesize', { text: 'こんにちは', voice: 'my-kikka' });
  assert.equal(gone.status, 400);
});
