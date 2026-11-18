// One synthesis worker process (src/engines.js, ZEN_TTS_WORKERS > 1): runs one job at a time from the server.
import { createRunner } from './engines.js';

const run = createRunner();

process.on('message', async (message) => {
  try {
    const result = await run(message);
    if (message.id !== undefined) process.send({ id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) process.send({ id: message.id, error: { name: error.constructor.name, message: error.message } });
  }
});
// The server went away: stop with it.
process.on('disconnect', () => process.exit(0));
