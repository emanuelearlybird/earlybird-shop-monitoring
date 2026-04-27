const SHOP_URL = 'https://earlybird-coffee.de';
const COLLECTION = 'kaffee';

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`);
  }

  return response.json();
}

async function testVariant(product, variant) {
  const cartClearUrl = `${SHOP_URL}/cart/clear.js`;
  const cartAddUrl = `${SHOP_URL}/cart/add.js`;

  await fetch(cartClearUrl, { method: 'POST' });

  const response = await fetch(cartAddUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      id: variant.id,
      quantity: 1
    })
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      message: text.slice(0, 300)
    };
  }

  return {
    ok: true,
    message: 'OK'
  };
}

(async () => {
  const url = `${SHOP_URL}/collections/${COLLECTION}/products.json?limit=250`;
  console.log(`Loading products from: ${url}`);

  const data = await fetchJson(url);
  const products = data.products || [];

  console.log(`Found ${products.length} products`);

  const failures = [];

  for (const product of products) {
    for (const variant of product.variants) {
      const label = `${product.title} / ${variant.title}`;

      if (!variant.available) {
        failures.push(`${label} is marked unavailable`);
        console.log(`FAIL: ${label} is marked unavailable`);
        continue;
      }

      const result = await testVariant(product, variant);

      if (result.ok) {
        console.log(`OK: ${label}`);
      } else {
        failures.push(`${label}: ${result.message}`);
        console.log(`FAIL: ${label}: ${result.message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) {
      console.log(`- ${failure}`);
    }

    process.exit(1);
  }

  console.log('\nAll variants are addable to cart.');
})();
