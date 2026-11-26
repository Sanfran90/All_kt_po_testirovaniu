const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  workers: 1,            // один воркер: покрытие кода копится между тестами
  fullyParallel: false,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true },
});
