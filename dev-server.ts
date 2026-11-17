// Dev launcher (NOT part of the submission): listens on a fixed port with the shop token from
// the env so sdk/run.ts can dial it. Do not commit this file to the entry repo.
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? '38363');
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
});
