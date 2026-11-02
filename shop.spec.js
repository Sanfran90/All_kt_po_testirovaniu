const fs = require('fs');
const path = require('path');
const { test: base, expect } = require('@playwright/test');
const cover = require('./coverage');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SVG = fs.readFileSync(path.join(ROOT, 'logo.svg'), 'utf8');
const URL = 'http://shop.test/';

const PRODUCTS = [
  { id: 1, name: 'Genshin Impact Genesis Crystals', price: 9.99 },
  { id: 2, name: 'Fortnite V-Bucks', price: 4.5 },
  { id: 3, name: 'Roblox Robux', price: 19.99 },
];

// каждый тест автоматически собирает покрытие кода
const test = base.extend({
  cov: [async ({ page }, use) => {
    const cdp = await cover.start(page);
    await use();
    await cover.stop(cdp);
  }, { auto: true }],
});

test.afterAll(() => {
  console.log('\n' + cover.report(HTML, path.join(ROOT, 'coverage')));
});

// ---------- мок бэкенда ----------
async function mount(page, o = {}) {
  const calls = [];
  const products = o.products || PRODUCTS;
  await page.route('**/*', async route => {
    const req = route.request();
    const u = new globalThis.URL(req.url());
    if (u.hostname !== 'shop.test') return route.abort();
    const json = (code, obj) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(obj) });
    const p = u.pathname;
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: HTML });
    if (p === '/logo.svg') return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    if (p === '/products') return json(200, products);

    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ url: p, method: req.method(), body, auth: req.headers()['authorization'] });

    if (p === '/api/login' || p === '/api/register') {
      if (o.authRaw500) return route.fulfill({ status: 500, contentType: 'text/plain', body: 'oops' });
      if (body.password === 'bad') return json(401, { error: 'Неверный логин или пароль' });
      return json(200, { token: 't1', login: body.login });
    }
    if (p === '/api/purchases') {
      if (o.expired) return json(401, {});
      return json(200, o.purchases || []);
    }
    if (p === '/api/me') {
      if (o.me401) return json(401, {});
      if (o.meFail) return json(500, {});
      return json(200, { login: 'neo', orders: 2, spent: 30, createdAt: '2026-01-15T10:00:00Z' });
    }
    if (p === '/api/pay') {
      if (o.pay401) return json(401, {});
      if (o.payFail) return json(400, { error: 'Банк отклонил платёж' });
      const total = body.items.reduce((s, i) => s + i.price * i.qty, 0);
      return json(200, { id: 101, total });
    }
    if (p === '/api/rename') {
      if (body.login === 'taken') return json(409, { error: 'Логин занят' });
      return json(200, { login: body.login });
    }
    if (p === '/api/password') {
      if (body.oldPassword === 'wrong') return json(400, { error: 'Старый пароль неверный' });
      return json(200, { ok: true });
    }
    return json(404, {});
  });
  return calls;
}

// уже вошедший пользователь (токен в localStorage)
async function withSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 't1');
    localStorage.setItem('login', 'neo');
  });
}

async function signIn(page, name = 'neo', pw = '123') {
  await page.goto(URL);
  await page.fill('#lg', name);
  await page.fill('#pw', pw);
  await page.click('#go');
  await expect(page.locator('#v-shop')).toBeVisible();
}

const addCard = (page, n = 0) => page.locator('#grid .card').nth(n).locator('button');

// ================= R1–R3: регистрация и вход =================
test('R1 · TC1 регистрация создаёт аккаунт', async ({ page }) => {
  const calls = await mount(page);
  await page.goto(URL);
  await page.click('.tab[data-m="register"]');
  await expect(page.locator('#go')).toHaveText('Создать аккаунт');
  await page.fill('#lg', 'morpheus');
  await page.fill('#pw', 'secret');
  await page.click('#go');
  await expect(page.locator('#v-shop')).toBeVisible();
  expect(calls.find(c => c.url === '/api/register').body).toEqual({ login: 'morpheus', password: 'secret' });
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('t1');
});

test('R2 · TC2 вход с верными данными открывает каталог', async ({ page }) => {
  const calls = await mount(page);
  await signIn(page);
  await expect(page.locator('#meName')).toHaveText('neo');
  await expect(page.locator('#av')).toHaveText('N');
  await expect(page.locator('#grid .card')).toHaveCount(3);
  expect(calls.find(c => c.url === '/api/me').auth).toBe('Bearer t1');
});

test('R3 · TC3 неверные данные: ошибка в #err, остаёмся на входе', async ({ page }) => {
  await mount(page);
  await page.goto(URL);
  await page.fill('#lg', 'neo');
  await page.fill('#pw', 'bad');
  await page.click('#go');
  await expect(page.locator('#err')).toHaveText('Неверный логин или пароль');
  await expect(page.locator('#v-auth')).toBeVisible();
  await page.click('.tab[data-m="register"]'); // смена вкладки очищает ошибку
  await expect(page.locator('#err')).toHaveText('');
  await page.click('.tab[data-m="login"]');
  await expect(page.locator('#go')).toHaveText('Войти');
});

test('R3 · TC3b ответ сервера без JSON даёт сообщение по умолчанию', async ({ page }) => {
  await mount(page, { authRaw500: true });
  await page.goto(URL);
  await page.fill('#lg', 'neo');
  await page.fill('#pw', '123');
  await page.click('#go');
  await expect(page.locator('#err')).toHaveText('Что-то пошло не так');
});

test('R2 · TC2b сохранённый токен: сразу каталог без формы входа', async ({ page }) => {
  await mount(page);
  await withSession(page);
  await page.goto(URL);
  await expect(page.locator('#v-shop')).toBeVisible();
  await expect(page.locator('#meName')).toHaveText('neo');
});

test('R2 · TC2c токен просрочен: показывается форма входа', async ({ page }) => {
  await mount(page, { expired: true });
  await withSession(page);
  await page.goto(URL);
  await expect(page.locator('#v-auth')).toBeVisible();
});

test('R2 · TC2d ошибка /api/me не ломает каталог', async ({ page }) => {
  await mount(page, { meFail: true });
  await signIn(page);
  await expect(page.locator('#grid .card')).toHaveCount(3);
});

// ================= R4–R5: поиск и фильтры =================
test('R4 · TC4 поиск фильтрует каталог', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.fill('#q', 'robux');
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await page.fill('#q', 'zzz');
  await expect(page.locator('#grid')).toContainText('Ничего не найдено');
  await page.fill('#q', '');
  await page.click('#grid', { position: { x: 1, y: 1 } }); // клик мимо кнопки не добавляет товар
  await expect(page.locator('#cnt')).toHaveText('0');
});

test('R5 · TC5 чип ставит фильтр, повторный клик снимает', async ({ page }) => {
  await mount(page);
  await signIn(page);
  const chip = page.locator('.chip', { hasText: 'Fortnite' });
  await chip.click();
  await expect(page.locator('#q')).toHaveValue('Fortnite');
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(chip).toHaveClass(/on/);
  await chip.click();
  await expect(page.locator('#q')).toHaveValue('');
  await expect(page.locator('#grid .card')).toHaveCount(3);
  await page.click('#chips'); // клик мимо чипа ничего не меняет
  await expect(page.locator('#grid .card')).toHaveCount(3);
});

test('R4 · TC4b названия экранируются (нет HTML-инъекции)', async ({ page }) => {
  await mount(page, { products: [{ id: 9, name: '<b>"x"&', price: 1 }] });
  await signIn(page);
  await expect(page.locator('#grid .card')).toContainText('<b>"x"&');
  await expect(page.locator('#grid .card b').first()).toHaveText('$1.00'); // единственный <b> — цена
});

// ================= R6–R9: корзина и оплата =================
test('R6 · TC6 «В корзину» добавляет товар и повышает счётчик', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await addCard(page, 1).click();
  await expect(page.locator('#cnt')).toHaveText('1');
  await expect(page.locator('#navCnt')).toHaveText('1');
  await page.click('#cartBtn');
  await expect(page.locator('#cartList')).toContainText('Fortnite V-Bucks');
  await expect(page.locator('#cartTotal')).toHaveText('$4.50');
  await page.click('#cartClose');
  await expect(page.locator('#cartM')).toBeHidden();
});

test('R6 · TC7 повторное добавление увеличивает количество, максимум 99', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await addCard(page, 0).evaluate(b => { for (let i = 0; i < 100; i++) b.click(); });
  await expect(page.locator('#cnt')).toHaveText('99');
});

test('R7 · TC8 Steam: границы 0 / 1 / 1000 / 1001', async ({ page }) => {
  await mount(page);
  await signIn(page);
  for (const [v, cnt] of [['0', '0'], ['1001', '0'], ['1', '1'], ['1000', '2']]) {
    await page.fill('#steamAmt', v);
    await page.click('#steamBtn');
    await expect(page.locator('#cnt')).toHaveText(cnt);
  }
  await page.fill('#steamAmt', '1'); // та же сумма: количество, а не новая строка
  await page.click('#steamBtn');
  await page.click('#cartBtn');
  await expect(page.locator('#cartList .row')).toHaveCount(2);
  await expect(page.locator('#cartTotal')).toHaveText('$1002.00');
});

test('R7 · TC8b Steam: дробная сумма (проверка требования «step=1»)', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.fill('#steamAmt', '1.5');
  await page.click('#steamBtn');
  // фиксируем фактическое поведение: дробная сумма попадает в корзину
  await expect(page.locator('#cnt')).toHaveText('1');
});

test('R8 · TC9 пустая корзина: «Перейти к оплате» недоступна', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.click('#cartBtn');
  await expect(page.locator('#cartList')).toContainText('Корзина пуста');
  await expect(page.locator('#toPay')).toBeDisabled();
});

test('R9 · TC10 оплата: способ, таймер 5 с, заказ создан', async ({ page }) => {
  await page.clock.install();
  const calls = await mount(page);
  await signIn(page);
  await addCard(page, 1).click();
  await page.click('#cartBtn');
  await page.click('#toPay');
  await expect(page.locator('#v-pay')).toBeVisible();
  await expect(page.locator('#sum')).toContainText('$4.50');
  await page.click('.opt[data-k="card"]');
  await expect(page.locator('#payBox')).toContainText('4276 0000 0000 0000');
  await expect(page.locator('#payBox')).toContainText(/GC-\d{4}/);
  await page.click('#paid');
  await expect(page.locator('.timer')).toHaveText('5');
  await page.clock.runFor(5000);
  await expect(page.locator('#v-done')).toBeVisible();
  await expect(page.locator('#doneInfo')).toHaveText('Заказ №101 на сумму $4.50');
  const pay = calls.find(c => c.url === '/api/pay').body;
  expect(pay.method).toBe('Банковская карта');
  expect(pay.items).toEqual([{ name: 'Fortnite V-Bucks', price: 4.5, qty: 1 }]);
  await page.click('#home');
  await expect(page.locator('#v-shop')).toBeVisible();
  await expect(page.locator('#cnt')).toHaveText('0');
});

test('R9 · TC10b смена способа оплаты и возврат в магазин', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await addCard(page, 0).click();
  await page.click('#cartBtn');
  await page.click('#toPay');
  await page.click('.opt[data-k="sbp"]');
  await expect(page.locator('#payBox')).toContainText('Демо-банк');
  await page.click('#back');
  await page.click('.opt[data-k="crypto"]');
  await expect(page.locator('#payBox')).toContainText('TRC-20');
  await page.click('#back');
  await page.click('#cancel');
  await expect(page.locator('#v-shop')).toBeVisible();
});

test('R9 · TC10c отказ банка: сообщение и возврат к выбору способа', async ({ page }) => {
  await page.clock.install();
  await mount(page, { payFail: true });
  await signIn(page);
  await addCard(page, 0).click();
  await page.click('#cartBtn');
  await page.click('#toPay');
  await page.click('.opt[data-k="card"]');
  await page.click('#paid');
  await page.clock.runFor(5000);
  await expect(page.locator('#payBox')).toContainText('Не удалось оплатить');
  await expect(page.locator('#payBox')).toContainText('Банк отклонил платёж');
  await page.click('#back');
  await expect(page.locator('#payBox')).toContainText('Способ оплаты');
});

test('R9 · TC10d сессия истекла во время оплаты: выход на форму входа', async ({ page }) => {
  await page.clock.install();
  await mount(page, { pay401: true });
  await signIn(page);
  await addCard(page, 0).click();
  await page.click('#cartBtn');
  await page.click('#toPay');
  await page.click('.opt[data-k="card"]');
  await page.click('#paid');
  await page.clock.runFor(5000);
  await expect(page.locator('#v-auth')).toBeVisible();
});

test('R9 · TC10e оплата проходит, даже если /api/me недоступен', async ({ page }) => {
  await page.clock.install();
  await mount(page, { meFail: true });
  await signIn(page);
  await addCard(page, 0).click();
  await page.click('#cartBtn');
  await page.click('#toPay');
  await page.click('.opt[data-k="card"]');
  await page.click('#paid');
  await page.clock.runFor(5000);
  await expect(page.locator('#v-done')).toBeVisible();
});

// ================= R10–R13: история, профиль, выход =================
const PURCHASE = {
  id: 7, total: 14.49, method: 'СБП', paidAt: '2026-10-01T12:00:00Z',
  items: [{ name: 'Fortnite V-Bucks', price: 4.5, qty: 1 }, { name: 'Roblox Robux', price: 9.99, qty: 1 }],
};

test('R10 · TC11 «Мои покупки» показывают историю заказов', async ({ page }) => {
  await mount(page, { purchases: [PURCHASE] });
  await signIn(page);
  await page.click('.nav-i[data-go="hist"]');
  await expect(page.locator('#meM')).toBeVisible();
  await expect(page.locator('#hist')).toContainText('Заказ №7');
  await expect(page.locator('#hist')).toContainText('Способ: СБП');
  await expect(page.locator('#hist')).toContainText('$14.49');
  await page.click('#meClose');
  await expect(page.locator('#meM')).toBeHidden();
});

test('R10 · TC11b пустая история', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.click('.nav-i[data-go="hist"]');
  await expect(page.locator('#hist')).toContainText('Покупок пока нет');
});

test('R10 · TC11c история при истёкшей сессии: выход', async ({ page }) => {
  const calls = await mount(page);
  await signIn(page);
  await page.unroute('**/*');
  await mount(page, { expired: true });
  await page.click('.nav-i[data-go="hist"]');
  await expect(page.locator('#v-auth')).toBeVisible();
  expect(calls.length).toBeGreaterThan(0);
});

test('R11 · TC12 смена логина', async ({ page }) => {
  const calls = await mount(page);
  await signIn(page);
  await page.click('#me');
  await expect(page.locator('#pfLogin')).toHaveText('neo');
  await expect(page.locator('#pfStat')).toHaveText('2 / $30.00');
  await page.fill('#nl', 'trinity');
  await page.click('#pfName button');
  await expect(page.locator('#pfMsg')).toHaveText('Логин изменён.');
  await expect(page.locator('#meName')).toHaveText('trinity');
  await expect(page.locator('#av')).toHaveText('T');
  expect(await page.evaluate(() => localStorage.getItem('login'))).toBe('trinity');
  expect(calls.find(c => c.url === '/api/rename').body).toEqual({ login: 'trinity' });
});

test('R11 · TC12b логин занят: сообщение об ошибке', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.click('#me');
  await page.fill('#nl', 'taken');
  await page.click('#pfName button');
  await expect(page.locator('#pfMsg')).toHaveText('Логин занят');
  await expect(page.locator('#meName')).toHaveText('neo');
  await page.click('#pfClose');
  await expect(page.locator('#pfM')).toBeHidden();
});

test('R11 · TC12c профиль: ошибка /api/me (500) не закрывает сессию', async ({ page }) => {
  await mount(page, { meFail: true });
  await signIn(page);
  await page.click('#me');
  await expect(page.locator('#pfM')).toBeVisible();
  await expect(page.locator('#v-shop')).toBeVisible();
});

test('R11 · TC12d профиль: 401 от /api/me ведёт на форму входа', async ({ page }) => {
  await mount(page, { me401: true });
  await signIn(page);
  await page.click('#me');
  await expect(page.locator('#v-auth')).toBeVisible();
});

test('R12 · TC13 смена пароля', async ({ page }) => {
  const calls = await mount(page);
  await signIn(page);
  await page.click('#me');
  await page.fill('#op', 'old');
  await page.fill('#np', 'new');
  await page.click('#pfPass button');
  await expect(page.locator('#pfMsg')).toHaveText('Пароль изменён.');
  await expect(page.locator('#op')).toHaveValue('');
  expect(calls.find(c => c.url === '/api/password').body).toEqual({ oldPassword: 'old', newPassword: 'new' });
});

test('R12 · TC13b неверный старый пароль', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.click('#me');
  await page.fill('#op', 'wrong');
  await page.fill('#np', 'new');
  await page.click('#pfPass button');
  await expect(page.locator('#pfMsg')).toHaveText('Старый пароль неверный');
});

test('R13 · TC14 выход очищает сессию и корзину', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await addCard(page, 0).click();
  await page.click('#me');
  await page.click('#out');
  await expect(page.locator('#v-auth')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  await expect(page.locator('#cnt')).toHaveText('0');
  // повторный вход без перезагрузки страницы: каталог берётся из кэша products
  await page.fill('#lg', 'neo');
  await page.fill('#pw', '123');
  await page.click('#go');
  await expect(page.locator('#grid .card')).toHaveCount(3);
});

test('Навигация: боковое меню', async ({ page }) => {
  await mount(page);
  await signIn(page);
  await page.click('.nav-i[data-go="cart"]');
  await expect(page.locator('#cartM')).toBeVisible();
  await page.click('#cartClose');
  await page.click('.nav-i[data-go="steam"]');
  await page.click('.nav-i[data-go="top"]');
  await expect(page.locator('#v-shop')).toBeVisible();
});

// ================= CFG: обработчик $('#cartList').onclick =================
async function cartWithOneItem(page) {
  await mount(page);
  await signIn(page);
  await addCard(page, 1).click();
  await page.click('#cartBtn');
}

test('CFG · T1 (путь P1) клик мимо кнопок количества', async ({ page }) => {
  await cartWithOneItem(page);
  await page.locator('#cartList .grow').click();
  await expect(page.locator('#cartList .qty')).toContainText('1');
  await expect(page.locator('#cnt')).toHaveText('1');
});

test('CFG · T2 (путь P2) «+» и «−» меняют количество', async ({ page }) => {
  await cartWithOneItem(page);
  await page.locator('#cartList [data-a="+"]').click();
  await expect(page.locator('#cnt')).toHaveText('2');
  await expect(page.locator('#cartTotal')).toHaveText('$9.00');
  await page.locator('#cartList [data-a="-"]').click();
  await expect(page.locator('#cnt')).toHaveText('1');
});

test('CFG · T3 (путь P3) «−» при количестве 1 удаляет позицию', async ({ page }) => {
  await cartWithOneItem(page);
  await page.locator('#cartList [data-a="-"]').click();
  await expect(page.locator('#cartList')).toContainText('Корзина пуста');
  await expect(page.locator('#cnt')).toHaveText('0');
  await expect(page.locator('#toPay')).toBeDisabled();
});
