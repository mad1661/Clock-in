/**
 * Browser smoke test for the worker and admin UI, driven with Playwright
 * against the Firebase emulator suite. It seeds its own data, so it needs a
 * FRESH emulator run (emulator data is in-memory and cleared on restart).
 *
 *   firebase emulators:start --project demo-clockin   # in one terminal
 *   npm --prefix web run test:ui                      # in another
 *
 * Geolocation is mocked per browser context, which is what lets us exercise
 * the three real-world cases: on site, off site, and permission denied.
 */
import { chromium } from 'playwright';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const BASE = 'http://127.0.0.1:5000';
const SITE = { latitude: 51.5074, longitude: -0.1278 };
const ADMIN = { email: 'boss@example.com', password: 'Password123!' };
const shots = process.env.SCREENSHOT_DIR || null;

// --- Seed: first admin, one job site, one worker ----------------------------
const seedApp = initializeApp({
  apiKey: 'demo',
  projectId: 'demo-clockin',
  appId: '1:1:web:1',
  storageBucket: 'demo-clockin.appspot.com',
});
const seedAuth = getAuth(seedApp);
connectAuthEmulator(seedAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
const seedFns = getFunctions(seedApp, 'us-central1');
connectFunctionsEmulator(seedFns, '127.0.0.1', 5001);

await createUserWithEmailAndPassword(seedAuth, ADMIN.email, ADMIN.password);
await httpsCallable(seedFns, 'bootstrapAdmin')({ displayName: 'The Boss' });
await seedAuth.currentUser.getIdToken(true);
await httpsCallable(seedFns, 'upsertJobSite')({
  name: 'Harbour Works',
  address: '12 Dock Street',
  lat: SITE.latitude,
  lng: SITE.longitude,
  radiusMeters: 150,
  active: true,
});
const seeded = (
  await httpsCallable(seedFns, 'createWorker')({
    email: 'pat@example.com',
    displayName: 'Pat Doyle',
    role: 'worker',
    jobSiteIds: [],
  })
).data;
const WORKER = { email: seeded.email, password: seeded.temporaryPassword };

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n} ${extra}`); }
};

async function shot(page, name, fullPage = false) {
  if (shots) await page.screenshot({ path: `${shots}/${name}`, fullPage });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
});

async function newPage({ geo, permissions = ['geolocation'] } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ...(geo ? { geolocation: geo } : {}),
    permissions,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('    [pageerror]', String(e).slice(0, 200)));
  return { ctx, page };
}

async function selectSite(page, name) {
  const value = await page.locator('#site').evaluate(
    (el, n) => [...el.options].find((o) => o.text.includes(n))?.value,
    name,
  );
  await page.selectOption('#site', value);
}

async function login(page, { email, password }) {
  await page.goto(BASE);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// --- 1. Worker on site, good GPS -------------------------------------------
console.log('\n=== Worker clocks in with a good fix, on site ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, WORKER);

  await page.waitForSelector('.clock-btn', { timeout: 20000 });
  check('clock screen loaded after sign-in', await page.locator('.clock-btn').isVisible());
  check('temporary-password warning shown', await page.getByText('temporary password').first().isVisible());

  await selectSite(page, 'Harbour Works');
  await shot(page, `ui-1-clock.png`);

  await page.getByRole('button', { name: /Clock in/ }).click();
  await page.waitForSelector('text=/Clocked in/', { timeout: 30000 });
  check('clock-in succeeded', await page.getByText('Clocked in').isVisible());
  check('location confirmed, not flagged', await page.getByText(/Location confirmed/).isVisible());
  check('no review banner', !(await page.getByText(/sent to your administrator/).isVisible().catch(() => false)));

  await page.waitForSelector('.elapsed', { timeout: 10000 });
  check('on-shift timer showing', /^\d:\d\d:\d\d$/.test((await page.locator('.elapsed').innerText()).trim()));
  await shot(page, `ui-2-onshift.png`);

  await page.getByRole('link', { name: 'My hours' }).click();
  await page.waitForSelector('text=Harbour Works');
  check('shift appears on the timesheet', await page.getByText('On shift').first().isVisible());

  await ctx.close();
}

// --- 2. Worker far away -> photo fallback ----------------------------------
console.log('\n=== Worker away from site is pushed to the photo fallback ===');
{
  const { ctx, page } = await newPage({ geo: { latitude: 52.5, longitude: -1.9, accuracy: 12 } });
  await login(page, WORKER);
  await page.waitForSelector('.clock-btn', { timeout: 20000 });

  await page.getByRole('button', { name: /Clock out/ }).click();
  await page.waitForSelector('text=/Take a photo instead/', { timeout: 30000 });
  check('photo fallback offered', await page.getByText('Take a photo instead').isVisible());
  check(
    'explains the distance problem',
    await page.getByText(/outside the boundary/i).first().isVisible(),
  );
  check('offers a location retry', await page.getByRole('button', { name: /Try location again/ }).isVisible());
  await shot(page, `ui-3-photo-required.png`, true);

  // A 2x2 JPEG stands in for a camera capture.
  const jpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  await page.setInputFiles('#site-photo', {
    name: 'capture.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(jpeg, 'base64'),
  });

  await page.waitForSelector('.photo-preview', { timeout: 15000 });
  check('photo preview rendered', await page.locator('.photo-preview').isVisible());
  await shot(page, `ui-4-photo-preview.png`, true);

  await page.getByRole('button', { name: /Submit for approval/ }).click();
  await page.waitForSelector('text=/Clocked out/', { timeout: 40000 });
  check('clock-out recorded via photo', await page.getByText('Clocked out').isVisible());
  check('flagged for admin approval', await page.getByText(/sent to your administrator/).isVisible());
  await shot(page, `ui-5-submitted.png`);

  await ctx.close();
}

// --- 3. Location permission denied -----------------------------------------
console.log('\n=== Location permission denied ===');
{
  const { ctx, page } = await newPage({ permissions: [] });
  await login(page, WORKER);
  await page.waitForSelector('.clock-btn', { timeout: 20000 });
  await selectSite(page, 'Harbour Works');
  await page.getByRole('button', { name: /Clock in/ }).click();

  await page.waitForSelector('text=/Take a photo instead/', { timeout: 40000 });
  check('denied permission routes to the photo fallback', await page.getByText('Take a photo instead').isVisible());
  check(
    'shows device-specific instructions to re-enable location',
    await page.getByText(/Privacy & Security/).isVisible(),
  );
  await shot(page, `ui-6-denied.png`, true);
  await ctx.close();
}

// --- 4. Admin -------------------------------------------------------------
console.log('\n=== Admin console ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, ADMIN);
  await page.waitForSelector('.nav', { timeout: 20000 });
  check('admin sees the admin nav', await page.getByRole('link', { name: 'Workers' }).isVisible());

  await page.getByRole('link', { name: 'Review' }).click();
  await page.waitForSelector('text=/Needs review/', { timeout: 20000 });
  check('review queue lists flagged shifts', await page.getByText('Pat Doyle').first().isVisible());
  await shot(page, `ui-7-review-queue.png`, true);

  const countBefore = Number(/\((\d+)\)/.exec(await page.locator('.card-head h2').first().innerText())[1]);
  await page.getByRole('button', { name: 'Review' }).first().click();
  await page.waitForSelector('.modal', { timeout: 15000 });
  check('evidence modal shows the photo punch', await page.getByText('Photo evidence').first().isVisible());
  check('evidence modal shows the verified punch', await page.getByText('Location verified').first().isVisible());
  await shot(page, `ui-8-review-detail.png`, true);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(
    (n) => !document.querySelector('.modal') &&
      Number(/\((\d+)\)/.exec(document.querySelector('.card-head h2')?.textContent ?? '(999)')[1]) < n,
    countBefore,
    { timeout: 20000 },
  );
  const countAfter = Number(/\((\d+)\)/.exec(await page.locator('.card-head h2').first().innerText())[1]);
  check('approving removes the shift from the queue', countAfter === countBefore - 1, `${countBefore} -> ${countAfter}`);

  await page.getByRole('link', { name: 'Workers' }).click();
  await page.getByText('Pat Doyle').first().waitFor({ timeout: 20000 }).catch(() => {});
  check('worker roster lists employees', await page.getByText('Pat Doyle').first().isVisible());
  await page.getByRole('button', { name: '+ Add employee' }).click();
  await page.waitForSelector('.modal');
  await page.getByLabel('Full name').fill('Robin Fox');
  await page.getByLabel('Email (their username)').fill('robin@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForSelector('text=/One-time password/', { timeout: 25000 });
  const pwd = (await page.locator('.credential .mono').innerText()).trim();
  check('one-time password issued and shown once', pwd.length >= 12, `got "${pwd}"`);
  await shot(page, `ui-9-new-worker.png`, true);
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('link', { name: 'Job sites' }).click();
  await page.getByText('Harbour Works').first().waitFor({ timeout: 20000 }).catch(() => {});
  check('job sites listed', await page.getByText('Harbour Works').first().isVisible());
  await shot(page, `ui-10-sites.png`, true);

  await page.getByRole('link', { name: 'Timesheets' }).click();
  await page.waitForSelector('text=/shifts/', { timeout: 20000 });
  check('timesheet totals rendered', await page.getByText(/total/).first().isVisible());
  await shot(page, `ui-11-timesheets.png`, true);

  await ctx.close();
}

// --- 5. Worker cannot reach admin routes -----------------------------------
console.log('\n=== Worker cannot reach admin routes ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, WORKER);
  await page.waitForSelector('.clock-btn', { timeout: 20000 });
  check('worker does not see admin nav', !(await page.getByRole('link', { name: 'Workers' }).isVisible().catch(() => false)));
  await page.goto(`${BASE}/admin/workers`);
  await page.waitForSelector('text=/Administrators only/', { timeout: 15000 });
  check('typing the admin URL is refused', await page.getByText('Administrators only').isVisible());
  await ctx.close();
}

await browser.close();
console.log(`\n${'='.repeat(46)}\n${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail === 0 ? 0 : 1);
