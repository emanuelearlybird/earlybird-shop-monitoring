const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const baseUrl = 'https://earlybird-coffee.de/collections/kaffee';

  console.log('Opening collection page...');
  await page.goto(baseUrl);

  const productLinks = await page.$$eval('a[href*="/products/"]', links =>
    [...new Set(links.map(l => l.href))]
  );

  console.log(`Found ${productLinks.length} products`);

  for (const link of productLinks) {
    console.log(`\nChecking product: ${link}`);

    await page.goto(link);

    // Varianten auswählen (falls vorhanden)
    const selects = await page.$$('select');

    if (selects.length > 0) {
      for (const select of selects) {
        const options = await select.$$('option');

        for (let i = 0; i < options.length; i++) {
          await select.selectOption({ index: i });

          const button = await page.$('button[type="submit"]');

          if (!button) {
            console.log('No add-to-cart button found');
            continue;
          }

          const disabled = await button.isDisabled();

          if (disabled) {
            console.log(`Variant ${i}: NOT available`);
          } else {
            await button.click();
            console.log(`Variant ${i}: OK`);

            // Warenkorb wieder leeren (einfach reload)
            await page.reload();
          }
        }
      }
    } else {
      const button = await page.$('button[type="submit"]');

      if (!button) {
        console.log('No add-to-cart button found');
      } else {
        const disabled = await button.isDisabled();

        if (disabled) {
          console.log('Product NOT available');
        } else {
          await button.click();
          console.log('Product OK');
        }
      }
    }
  }

  await browser.close();
})();
