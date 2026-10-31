import { resolve } from 'node:path';
import { createApp } from './server.js';

const bind = process.env.ZEN_TTS_BIND ?? '127.0.0.1:50023';
const separator = bind.lastIndexOf(':');
if (separator < 1) throw new Error(`ZEN_TTS_BIND must be host:port, got ${bind}`);
const host = bind.slice(0, separator);
const port = Number(bind.slice(separator + 1));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in ZEN_TTS_BIND: ${bind}`);
const modelsPath = resolve(process.env.ZEN_TTS_MODELS ?? 'models');

createApp({ modelsPath }).listen(port, host, () => {
  console.log(`zen-tts-server listening on ${host}:${port} (models: ${modelsPath})`);
});
