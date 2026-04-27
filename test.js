// Shop Monitoring – earlybird-coffee.de
//
// Approach
// --------
// The shop is fronted by a Cloudflare-style WAF that aggressively
// rate-limits POST traffic to /cart/add.js coming from a single IP
// (≈10 successful adds, then long 429/"Verifying your connection..." block).
// GitHub-Actions runner IPs hit that limit very quickly.
//
// To stay useful on a daily schedule we therefore:
//
//   1) ALWAYS check every variant via products.json (free, reliable):
//        - variant.available === false  -> hard failure
//
//   2) ADDITIONALLY run a real /cart/add.js smoke test for as many
//      variants as the WAF allows, batched and re-warmed via real
//      page navigations:
//        - HTTP 422/4xx with a real JSON error  -> hard failure
//        - HTTP 429 / HTML interstitial after recovery -> SKIP (warn,
//          but don’t fail the build, because the IP is being throttled,
//          not because the variant is broken).
//
// This delivers:
//   - Reliable daily signal for "is anything sold-out / unbuyable?"
//     (covered by products.json)
//   - Real functional verification of /cart/add.js for the variants we
//     can reach without false-positive WAF noise.
//
// Endpoints used:
//   GET  /collections/<handle>/products.json?limit=250
//   POST /cart/add.js   { id: VARIANT_ID, quantity: 1 }
//
// Exit code: 1 on any HARD failure, otherwise 0.

const { chromium } = require('playwright');

const SHOP_URL = 'https://earlybird-coffee.de';
const COLLECTION = 'kaffee';
const USER_AGENT =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36';

// Pacing for the cart/add smoke test
const BATCH_SIZE = 4;
const BATCH_INNER_DELAY_MS = 1500;
const BATCH_COOLDOWN_MS = 12000;
const RECOVERY_WAIT_MS = 25000;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRealContent(page) {
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

async function fetchProducts(page) {
            const url = `${SHOP_URL}/collections/${COLLECTION}/products.json?limit=250`;
            let res;
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                          res = await pageFetch(page, url);
                          if (!looksBlocked(res) && res.ok && res.body) return res.body.products || [];
                          console.log(
                                          `  products.json blocked (status ${res.status}), recovery ${attempt + 1}/${MAX_RETRIES + 1}`
                                        );
                          await sleep(RECOVERY_WAIT_MS);
                          try { await warmUp(page); } catch (_) {}
            }
            throw new Error(
                          `products.json failed after retries (status ${res && res.status}): ${res && res.text}`
                        );
}

async function addVariantOnce(page, variantId) {
            return pageFetch(page, `${SHOP_URL}/cart/add.js`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id: variantId, quantity: 1 })
            });
}

// Returns { kind: 'ok' | 'fail' | 'blocked', res }
async function checkVariant(page, variantId, label) {
            for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
                          const res = await addVariantOnce(page, variantId);
                          const ok =
                                          res.ok &&
                                          res.body &&
                                          (res.body.id || Array.isArray(res.body.items));
                          if (ok) return { kind: 'ok', res };
                          if (!looksBlocked(res)) return { kind: 'fail', res };
                          if (attempt > MAX_RETRIES) return { kind: 'blocked', res };
                          console.log(
                                          `  blocked on ${label} (status ${res.status}), recovery ${attempt}/${MAX_RETRIES}: ` +
                                          `waiting ${RECOVERY_WAIT_MS}ms then re-warming...`
                                        );
                          await sleep(RECOVERY_WAIT_MS);
                          try { await warmUp(page); } catch (_) {}
            }
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

   const hardFailures = [];   // -> exit 1
   const skipped = [];        // -> warn only
   let okCount = 0;

   try {
                 console.log(`Warming up: ${SHOP_URL}/collections/${COLLECTION}`);
                 await warmUp(page);

              console.log('Loading products.json ...');
                 const products = await fetchProducts(page);
                 console.log(`Found ${products.length} products`);
                 if (products.length === 0) {
                                 throw new Error('products.json returned 0 products');
                 }

              // 1) availability check on every variant
              const all = [];
                 for (const product of products) {
                                 for (const variant of product.variants || []) {
                                                   const label = `${product.title} / ${variant.title} (id ${variant.id})`;
                                                   if (variant.available === false) {
                                                                       const msg = `${label}: variant.available === false`;
                                                                       console.log(`FAIL: ${msg}`);
                                                                       hardFailures.push(msg);
                                                   } else {
                                                                       all.push({ product, variant, label });
                                                   }
                                 }
                 }
                 console.log(
                                 `\nAvailability check: ${all.length} available, ` +
                                 `${hardFailures.length} unavailable.`
                               );

              // 2) functional cart/add smoke test (batched)
              console.log(`\nFunctional cart/add.js test:`);
                 let inBatch = 0;
                 let givenUp = false;

              for (const { variant, label } of all) {
                              if (givenUp) {
                                                skipped.push(`${label}: skipped (WAF cooldown)`);
                                                continue;
                              }

                   if (inBatch >= BATCH_SIZE) {
                                     console.log(`-- batch cooldown (${BATCH_COOLDOWN_MS}ms) + re-warm --`);
                                     await sleep(BATCH_COOLDOWN_MS);
                                     try { await warmUp(page); } catch (_) {}
                                     inBatch = 0;
                   }

                   let result;
                              try {
                                                result = await checkVariant(page, variant.id, label);
                              } catch (err) {
                                                const msg = `${label}: exception ${err && err.message}`;
                                                console.log(`FAIL: ${msg}`);
                                                hardFailures.push(msg);
                                                inBatch++;
                                                await sleep(BATCH_INNER_DELAY_MS);
                                                continue;
                              }

                   if (result.kind === 'ok') {
                                     okCount++;
                                     console.log(`OK:    ${label}`);
                   } else if (result.kind === 'fail') {
                                     const detail = result.res.body
                                       ? JSON.stringify(result.res.body).slice(0, 200)
                                                         : result.res.text;
                                     const msg = `${label}: add.js status ${result.res.status} ${detail}`;
                                     console.log(`FAIL:  ${msg}`);
                                     hardFailures.push(msg);
                   } else {
                                     // blocked – treat as skipped, do not fail the build
                                const msg = `${label}: WAF blocked (status ${result.res.status})`;
                                     console.log(`SKIP:  ${msg}`);
                                     skipped.push(msg);
                                     // After repeated WAF blocks the IP is in a long penalty box;
                                // stop spending time/CI minutes hammering the endpoint.
                                if (skipped.length >= 3) {
                                                    console.log(
                                                                          `Too many consecutive WAF blocks (${skipped.length}). ` +
                                                                          `Skipping remaining cart/add.js checks.`
                                                                        );
                                                    givenUp = true;
                                }
                   }

                   inBatch++;
                              await sleep(BATCH_INNER_DELAY_MS);
              }

              console.log(
                              `\nCart/add summary: ok=${okCount}, fail=${hardFailures.length}, ` +
                              `skipped=${skipped.length}/${all.length} variants.`
                            );
   } catch (err) {
                 console.error(`Fatal error: ${err && (err.stack || err.message) || err}`);
                 hardFailures.push(`fatal: ${err && err.message || err}`);
   } finally {
                 await browser.close().catch(() => {});
   }

   if (skipped.length > 0) {
                 console.log(`\n${skipped.length} skipped (WAF):`);
                 for (const s of skipped) console.log(`- ${s}`);
   }

   if (hardFailures.length > 0) {
                 console.log(`\n${hardFailures.length} HARD failure(s):`);
                 for (const f of hardFailures) console.log(`- ${f}`);
                 process.exit(1);
   }

   console.log('\nAll checked variants are orderable. No hard failures.');
            process.exit(0);
})();
