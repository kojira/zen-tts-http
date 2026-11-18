// Where synthesis runs: in worker processes (src/synth-worker.js), never on the HTTP process. speak() is synchronous
// work on the thread that calls it, so on the HTTP process it blocks the event loop: one process then uses one core, and
// under load a reused keep-alive connection can be closed by its idle timer before its next request is read (the client
// sees a connection reset). With the work in a worker process the HTTP process stays free.
//
//   workers = N (default 1): N worker processes, one request at a time each, from one first-come queue. Processes, not
//                            worker_threads: the native kernel build keeps its buffer pointer in a process-wide variable,
//                            so two threads of one process would overwrite each other's.
//
// Each worker keeps its own voice cache (a voice is loaded on first use there, about 110-150 MB per voice per worker).
// Jobs: {op: 'synthesize', key, load, text, options} -> WAV bytes; {op: 'analyze', key, load, text, dict} -> reading;
// {op: 'check', key, load} loads a voice once (refused files throw) and keeps it as key; {op: 'forget', key}.

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import * as zenTts from 'zen-tts/node';
import { analyzeWord, AnalyzeError } from './analyze.js';

const { ZenTtsNode, wavBytes } = zenTts;
const WORKER = new URL('./synth-worker.js', import.meta.url);

/** ZEN_TTS_WORKERS: unset or '' = 1, 'auto' = the cores this process may use, else an integer from 1 to 256. */
export function workerCount(value) {
  if (value === undefined || value === '') return 1;
  if (value === 'auto') return availableParallelism();
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error(`ZEN_TTS_WORKERS must be auto or 1 to 256, got ${value}`);
  return n;
}

/** One voice cache and the jobs on it, inside each worker process. */
export function createRunner() {
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
  return async function run(job) {
    if (job.op === 'synthesize') {
      const result = await (await load(job.key, job.load)).speak(job.text, job.options);
      return wavBytes(result.pcm, result.sampleRate);
    }
    if (job.op === 'analyze') return analyzeWord(await load(job.key, job.load), job.text, job.dict);
    if (job.op === 'check') {
      // load() reads every file into memory, so the engine stays valid after the files are moved.
      loaded.set(job.key, Promise.resolve(await ZenTtsNode.load(job.load)));
      return true;
    }
    if (job.op === 'forget') return loaded.delete(job.key);
    throw new Error(`unknown job: ${job.op}`);
  };
}

export function createEngines(workers = 1) {
  return new Pool(workers);
}

class Pool {
  constructor(workers) {
    this.workers = workers;
    this.queue = [];
    this.closed = false;
    this.nextId = 1;
    this.slots = Array.from({ length: workers }, () => this.spawn());
  }

  spawn() {
    const slot = { child: fork(WORKER, [], { serialization: 'advanced' }), job: null, keys: new Set(), started: Date.now() };
    // A failed start also ends in 'exit', handled below.
    slot.child.on('error', (error) => console.error('synthesis worker:', error.message));
    slot.child.on('message', (message) => {
      const job = slot.job;
      if (!job || message.id !== job.id) return;
      slot.job = null;
      if (message.error) {
        const error = message.error.name === 'AnalyzeError' ? new AnalyzeError(message.error.message) : new Error(message.error.message);
        job.reject(error);
      } else {
        if (job.key) slot.keys.add(job.key);
        job.resolve(message.result);
      }
      this.dispatch();
    });
    slot.child.on('exit', (code, signal) => {
      const job = slot.job;
      slot.job = null;
      job?.reject(new Error(`synthesis worker stopped (${signal ?? code})`));
      if (this.closed) return;
      // A new process takes the place; queued requests go on. One that stopped right after starting waits a second, so a
      // worker that cannot start does not restart in a tight loop.
      console.error(`synthesis worker stopped (${signal ?? code}); starting a new one`);
      const restart = () => {
        const i = this.slots.indexOf(slot);
        if (i < 0 || this.closed) return;
        this.slots[i] = this.spawn();
        this.dispatch();
      };
      if (Date.now() - slot.started < 1000) setTimeout(restart, 1000).unref();
      else restart();
    });
    return slot;
  }

  run(job) {
    if (this.closed) return Promise.reject(new Error('the server is closing'));
    return new Promise((resolve, reject) => {
      this.queue.push({ ...job, id: this.nextId++, resolve, reject });
      this.dispatch();
    });
  }

  dispatch() {
    while (this.queue.length) {
      const idle = this.slots.filter((s) => !s.job && s.child.connected);
      if (!idle.length) return;
      const job = this.queue.shift();
      // First come, first served; among idle workers, one that has the voice loaded already.
      const slot = idle.find((s) => s.keys.has(job.key)) ?? idle[0];
      slot.job = job;
      const { resolve, reject, ...message } = job;
      slot.child.send(message);
    }
  }

  forget(key) {
    for (const slot of this.slots) {
      slot.keys.delete(key);
      if (slot.child.connected) slot.child.send({ op: 'forget', key });
    }
  }

  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('the server is closing'));
    for (const slot of this.slots) slot.child.kill();
  }
}
