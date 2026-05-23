import { HappyAdapter } from './adapter.js';
import { BackendSender } from './sender.js';
import { loadCredentials } from './happyFiles.js';

const backendUrl = process.env.BACKEND_URL;
const accountToken = process.env.ACCOUNT_TOKEN;
if (!backendUrl || !accountToken) {
  console.error('BACKEND_URL and ACCOUNT_TOKEN are required');
  process.exit(1);
}
const happyServerUrl = process.env.HAPPY_SERVER_URL ?? 'https://api.cluster-fluster.com';

// The socket auth uses the user's OWN Happy token from ~/.happy/access.key.
const happyToken = loadCredentials().token;

const sender = new BackendSender({ backendUrl, accountToken });

const adapter = new HappyAdapter({
  serverUrl: happyServerUrl,
  accountToken: happyToken,
});

adapter.start((event) => {
  sender.sendEvent(event).catch((err) => {
    console.error(`[emitter] failed to send event for ${event.sessionId}:`, err);
  });
  console.log(`[emitter] ${event.projectLabel} ${event.sessionId} -> ${event.status}`);
});

console.log(`[emitter] started; Happy=${happyServerUrl} backend=${backendUrl}`);

const shutdown = () => {
  console.log('[emitter] shutting down');
  adapter.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
