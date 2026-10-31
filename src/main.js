import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHandler } from './server.js';

function parseBind(name, value) {
  const separator = value.lastIndexOf(':');
  if (separator < 1) throw new Error(`${name} must be host:port, got ${value}`);
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in ${name}: ${value}`);
  return { host, port };
}

const modelsPath = resolve(process.env.ZEN_TTS_MODELS ?? 'models');
const dataPath = process.env.ZEN_TTS_DATA ? resolve(process.env.ZEN_TTS_DATA) : undefined;
// One handler, so both listeners share the loaded voices.
const handler = createHandler({ modelsPath, dataPath });

const binds = [['ZEN_TTS_BIND', process.env.ZEN_TTS_BIND ?? '127.0.0.1:50023']];
if (process.env.ZEN_TTS_ADMIN_BIND) binds.push(['ZEN_TTS_ADMIN_BIND', process.env.ZEN_TTS_ADMIN_BIND]);

for (const [name, value] of binds) {
  const { host, port } = parseBind(name, value);
  createServer(handler).listen(port, host, () => {
    console.log(`zen-tts-server listening on ${host}:${port} (${name}; models: ${modelsPath}; data: ${dataPath ?? 'none'})`);
  });
}
