// Shop Monitoring – earlybird-coffee.de
//
// The shop is fronted by a bot/CDN protection layer that issues
// HTTP 429 + an HTML "Verifying your connection..." interstitial when
// requests come in too fast. Strategy:
//
//   1) Drive a real Chromium via Playwright (cookies + JS challenge passed).
//   2) Throttle one variant per ~2 seconds.
//   3) On rate-limit / interstitial, do a full page navigation back to the
//      storefront. That triggers Cloudflare to mint a fresh clearance cookie
//      and unblocks the session.
//
// What is checked:
//   GET  /collections/<handle>/products.json?limit=250  -> all variants
//   For each variant:
//     POST /cart/clear.js
//     POST /cart/add.js   { id: VARIANT_ID, quantity: 1 }
//
// Failure conditions:
//   - variant.available === false in products.json
//   - cart/add.js does not return a valid JSON line item after recovery
// Exit 1 on any failure, 0 otherwise.

const { chromium } = require('playwright');

const SHOP_URL = 'https://earlybird-coffee.de';
const COLLECTION = 'kaffee';
const USER_AGENT =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36';

// Pacing
const VARIANT_DELAY_MS = 2000;       // delay between variants
const RECOVERY_WAIT_MS = 15000;      // pause before re-navigating after a block
const MAX_BLOCK_RECOVERIES = 3;      // how often we try to unblock per variant

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRealContent(page) {
        // Bot-protection layers serve an interstitial titled
  // "Verifying your connection...". Wait until the real shop is loaded.
  const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
                  const title = await page.title().catch(() => '');
                  if (title && !/verify|verifying|just a moment/i.test(title)) return;
                  await page.waitForTimeout(1000);
        }
}

async function warmUp(page) {
        await page.goto(`${SHOP_URL}/collections/${COLLECTION}`, {
                  waitUntil: 'domcontentloaded',
                  timeout: 60000
        });
        await waitForRealContent(page);
}

// Run one fetch inside the page context.
async function pageFetch(page, url, init) {
        return page.evaluate(
                  async ({ u, opts }) => {
                              try {
                                            const r = await fetch(u, {
                                                            credentials: 'include',
                                                            ...opts,
                                                            headers: { Accept: 'application/json', ...(opts && opts.headers) }
                                            });
                                            const text = await r.text();
                                            let body = null;
                                            try { body = JSON.parse(text); } catch (_) {}
                                            return { status: r.status, ok: r.ok, body, text: text.slice(0, 200) };
                              } catch (e) {
                                            return { status: 0, ok: false, body: null, text: String(e).slice(0, 200) };
                              }
                  },
              { u: url, opts: init || {} }
                );
}

function looksBlocked(res) {
        if (!res) return true;
        if (res.status === 429 || res.status === 403 || res.status === 503) return true;
        if (!res.body && /verifying your connection|just a moment|<!DOCTYPE/i.test(res.text)) return true;
        return false;
}

// Try a request; if blocked, re-warm the session and retry. Up to N recoveries.
async function callWithRecovery(page, label, fn) {
        let res = await fn();
        for (let i = 0; i < MAX_BLOCK_RECOVERIES && looksBlocked(res); i++) {
                  console.log(
                              `  blocked on ${label} (status ${res.status}). ` +
                              `recovery ${i + 1}/${MAX_BLOCK_RECOVERIES}: waiting ${RECOVERY_WAIT_MS}ms then re-warming...`
                            );
                  await sleep(RECOVERY_WAIT_MS);
                  try { await warmUp(page); } catch (_) { /* ignore */ }
                  res = await fn();
        }
        return res;
}

async function fetchProducts(page) {
        const url = `${SHOP_URL}/collections/${COLLECTION}/products.json?limit=250`;
        const res = await callWithRecovery(page, 'products.json', () =>
                  pageFetch(page, url)
                                             );
        if (!res.ok || !res.body) {
                  throw new Error(
                              `products.json failed (status ${res.status}): ${res.text}`
                            );
        }
        return res.body.products || [];
}

async function clearCart(page) {
        return callWithRecovery(page, 'cart/clear.js', () =>
                  pageFetch(page, `${SHOP_URL}/cart/clear.js`, { method: 'POST' })
                                  );
}

async function addVariant(page, variantId) {
        return callWithRecovery(page, `cart/add.js id=${variantId}`, () =>
                  pageFetch(page, `${SHOP_URL}/cart/add.js`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ id: variantId, quantity: 1 })
                  })
                                  );
}

(async () => {
        const browser = await chromium.launch({
                  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
        });
        const context = await browser.newContext({
                  userAgent: USER_AGENT,
                  locale: 'de-DE',
                  extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' }
        });
        const page = await context.newPage();

   const failures = [];
        let totalVariants = 0;

   try {
             console.log(`Warming up: ${SHOP_URL}/collections/${COLLECTION}`);
             await warmUp(page);

          console.log('Loading products.json ...');
             const products = await fetchProducts(page);
             console.log(`Found ${products.length} products`);
             if (products.length === 0) {
                         throw new Error('products.json returned 0 products');
             }

          for (const product of products) {
                      for (const variant of product.variants || []) {
                                    totalVariants++;
                                    const label = `${product.title} / ${variant.title} (id ${variant.id})`;

                        if (variant.available === false) {
                                        const msg = `${label}: variant.available === false`;
                                        console.log(`FAIL: ${msg}`);
                                        failures.push(msg);
                                        continue;
                        }

                        try {
                                        await clearCart(page);
                                        const res = await addVariant(page, variant.id);

                                      const addedOk =
                                                        res &&
                                                        res.ok &&
                                                        res.body &&
                                                        (res.body.id || Array.isArray(res.body.items));

                                      if (addedOk) {
                                                        console.log(`OK:   ${label}`);
                                      } else {
                                                        const detail = res && res.body
                                                          ? JSON.stringify(res.body).slice(0, 200)
                                                                            : (res ? res.text : 'no response');
                                                        const status = res ? res.status : '?';
                                                        const msg = `${label}: add.js status ${status} ${detail}`;
                                                        console.log(`FAIL: ${msg}`);
                                                        failures.push(msg);
                                      }
                        } catch (err) {
                                        const msg = `${label}: exception ${err && err.message}`;
                                        console.log(`FAIL: ${msg}`);
                                        failures.push(msg);
                        }

                        await sleep(VARIANT_DELAY_MS);
                      }
          }

          console.log(`\nChecked ${totalVariants} variants total.`);
   } catch (err) {
             console.error(`Fatal error: ${err && (err.stack || err.message) || err}`);
             failures.push(`fatal: ${err && err.message || err}`);
   } finally {
             await browser.close().catch(() => {});
   }

   if (failures.length > 0) {
             console.log(`\n${failures.length} failure(s):`);
             for (const f of failures) console.log(`- ${f}`);
             process.exit(1);
   }

   console.log('\nAll variants are orderable.');
        process.exit(0);
})();
