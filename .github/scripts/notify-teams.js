// Sends a Microsoft Teams notification using the Incoming Webhook URL stored
// in the TEAMS_WEBHOOK_URL environment variable. Reads structured failures
// from failures.json (produced by test.js).
//
// If TEAMS_WEBHOOK_URL is not set, this script exits silently.

const fs = require('fs');
const https = require('https');

const webhook = process.env.TEAMS_WEBHOOK_URL;
if (!webhook) {
  console.log('TEAMS_WEBHOOK_URL not set – skipping.');
  process.exit(0);
}

let data = { failures: [] };
try {
  data = JSON.parse(fs.readFileSync('failures.json', 'utf8'));
} catch (e) {
  console.warn('Could not read failures.json:', e.message);
}
const failures = Array.isArray(data.failures) ? data.failures : [];

const runUrl = (process.env.GH_SERVER_URL || 'https://github.com') +
  '/' + (process.env.GH_REPOSITORY || '') +
  '/actions/runs/' + (process.env.GH_RUN_ID || '');

const facts = failures.length === 0
  ? '_(keine strukturierten Fehler – siehe Logs)_'
  : failures.map(f =>
      '• **' + f.productTitle + '** – ' + f.variantTitle +
      ' (id ' + f.variantId + '): ' + f.reason
    ).join('\n');

const text =
  '**🚨 Shop Monitoring fehlgeschlagen – ' + failures.length + ' Variante(n)**\n\n' +
  facts + '\n\n' +
  '[Run / Logs ansehen](' + runUrl + ')';

const payload = JSON.stringify({ text });

const url = new URL(webhook);
const opts = {
  hostname: url.hostname,
  port: url.port || 443,
  path: url.pathname + url.search,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(opts, res => {
  console.log('Teams webhook responded:', res.statusCode);
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (body) console.log('Teams body:', body.slice(0, 500));
  });
});
req.on('error', err => {
  console.error('Teams webhook error:', err.message);
  // Don't fail the workflow because of a notification problem
  process.exit(0);
});
req.write(payload);
req.end();
