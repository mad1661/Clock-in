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
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  getDocs,
  query,
  where,
} from 'firebase/firestore';

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
const seedDb = getFirestore(seedApp);
connectFirestoreEmulator(seedDb, '127.0.0.1', 8080);

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
await httpsCallable(seedFns, 'updateCompanySettings')({ photoFallbackEnabled: true });

const seeded = (
  await httpsCallable(seedFns, 'createWorker')({
    email: 'pat@example.com',
    displayName: 'Pat Doyle',
    role: 'worker',
    jobSiteIds: [],
  })
).data;
const WORKER = { email: seeded.email, password: seeded.temporaryPassword };

/**
 * Backdates the worker's shift so a correction can propose times that are still
 * in the past. The server refuses future finish times, and a test that punches
 * "now" would otherwise always trip that guard.
 */
async function backdateWorkerShift() {
  const snap = await getDocs(
    query(collection(seedDb, 'shifts'), where('userId', '==', seeded.uid)),
  );
  const shift = snap.docs.find((d) => d.data().status === 'closed');
  if (!shift) throw new Error('No closed shift to backdate');
  const start = Date.now() - 8 * 3600_000;
  await httpsCallable(seedFns, 'adjustShift')({
    shiftId: shift.id,
    clockInAt: start,
    clockOutAt: start + 3600_000,
    note: 'Backdated so the correction flow has a past shift to work on.',
  });
}

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

  const needsReviewHeading = page.getByRole('heading', { name: /Needs review/ });
  const readCount = async () =>
    Number(/\((\d+)\)/.exec(await needsReviewHeading.innerText())[1]);
  const countBefore = await readCount();
  await page.getByRole('button', { name: 'Review', exact: true }).first().click();
  await page.waitForSelector('.modal', { timeout: 15000 });
  check('evidence modal shows the photo punch', await page.getByText('Photo evidence').first().isVisible());
  check('evidence modal shows the verified punch', await page.getByText('Location verified').first().isVisible());
  await shot(page, `ui-8-review-detail.png`, true);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(
    (n) => {
      if (document.querySelector('.modal')) return false;
      const heading = [...document.querySelectorAll('.card-head h2')].find((h) =>
        h.textContent?.startsWith('Needs review'),
      );
      const match = /\((\d+)\)/.exec(heading?.textContent ?? '(999)');
      return match ? Number(match[1]) < n : false;
    },
    countBefore,
    { timeout: 20000 },
  );
  const countAfter = await readCount();
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

// --- 5. Worker requests a correction; supervisor approves it ---------------
console.log('\n=== Worker requests a change, supervisor approves ===');
await backdateWorkerShift();
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, WORKER);
  await page.getByRole('link', { name: 'My hours' }).click();
  await page.getByRole('button', { name: 'Request a change' }).first().waitFor({ timeout: 20000 });
  check('worker can ask for a correction', true);

  await page.getByRole('button', { name: 'Request a change' }).first().click();
  await page.waitForSelector('.modal', { timeout: 15000 });
  check(
    'the modal says a supervisor must approve',
    await page.getByText(/supervisor has to approve/i).isVisible(),
  );

  // Submitting without a reason must not go through — the supervisor needs one.
  await page.getByRole('button', { name: /Send to my supervisor/ }).click();
  check(
    'a reason is required',
    await page.locator('#e-reason').evaluate((el) => !el.checkValidity()) &&
      (await page.locator('.modal').isVisible()),
  );

  await page.getByLabel('What happened? (required)').fill('Phone died — I finished at 16:30.');
  const finish = await page.locator('#e-out').inputValue();
  // Push the finish time an hour later than recorded.
  const bumped = new Date(new Date(finish).getTime() + 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  await page
    .locator('#e-out')
    .fill(
      `${bumped.getFullYear()}-${pad(bumped.getMonth() + 1)}-${pad(bumped.getDate())}T${pad(bumped.getHours())}:${pad(bumped.getMinutes())}`,
    );
  await page.getByRole('button', { name: /Send to my supervisor/ }).click();

  await page.getByText('Waiting on your supervisor').waitFor({ timeout: 25000 });
  check('the request shows as waiting', await page.getByText('Waiting on your supervisor').isVisible());
  check('the worker can withdraw it', await page.getByRole('button', { name: 'Withdraw request' }).isVisible());
  await shot(page, `ui-12-change-pending.png`, true);
  await ctx.close();
}

{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Review change' }).first().waitFor({ timeout: 20000 });
  check('the change reaches the supervisor queue', true);
  await shot(page, `ui-13-change-queue.png`, true);

  await page.getByRole('button', { name: 'Review change' }).first().click();
  await page.waitForSelector('.modal', { timeout: 15000 });
  check('supervisor sees recorded vs requested', await page.locator('.compare').isVisible());
  check('supervisor sees the reason', await page.getByText(/Phone died/).isVisible());
  await shot(page, `ui-14-change-review.png`, true);

  await page.getByRole('button', { name: 'Approve change' }).click();
  await page.getByText('No outstanding change requests').waitFor({ timeout: 25000 });
  check('approving clears the change queue', true);
  await ctx.close();
}

{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, WORKER);
  await page.getByRole('link', { name: 'My hours' }).click();
  await page.getByText('Your change was approved').first().waitFor({ timeout: 20000 });
  check('the worker is told it was approved', true);
  check(
    'the corrected shift is marked as worker-edited',
    await page.getByText(/Times corrected at the worker/).first().isVisible(),
  );
  await shot(page, `ui-15-change-approved.png`, true);
  await ctx.close();
}

// --- 6. Device is recorded and shown ---------------------------------------
console.log('\n=== Device is recorded on each punch ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Timesheets' }).click();
  await page.locator('.device-line').first().waitFor({ timeout: 20000 });
  const deviceText = await page.locator('.device-line').first().innerText();
  check(
    'the timesheet says what they clocked in on',
    /iPhone/.test(deviceText),
    `got "${deviceText}"`,
  );
  await shot(page, `ui-16-device-timesheet.png`, true);

  await page.getByRole('button', { name: 'Details' }).first().click();
  await page.waitForSelector('.modal', { timeout: 15000 });
  check(
    'the evidence view names the device',
    await page.locator('.modal .device-name').first().isVisible(),
  );
  check(
    'the evidence view shows a device handle',
    /^D-[A-Z0-9]+$/.test(
      (await page.locator('.modal .device-line .pill').first().innerText()).trim(),
    ),
  );
  await shot(page, `ui-17-device-evidence.png`, true);
  await ctx.close();
}

// --- 7. Offline: the punch survives a dead connection ----------------------
console.log('\n=== No signal: punch is held and synced later ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, WORKER);
  await page.waitForSelector('.clock-btn', { timeout: 20000 });
  await selectSite(page, 'Harbour Works');

  // Cut the network the way a basement does: the app is already loaded, the
  // request simply never arrives.
  await ctx.setOffline(true);
  await page.getByRole('button', { name: /Clock in/ }).click();

  await page.getByText(/saved on this phone/i).first().waitFor({ timeout: 45000 });
  check('a punch with no signal is saved, not lost', true);
  check(
    'the worker is told it will send itself',
    await page.getByText(/automatically/i).first().isVisible(),
  );
  await shot(page, `ui-18-offline-saved.png`, true);

  // Signal returns.
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await page.locator('.elapsed').waitFor({ timeout: 45000 });
  check('it syncs on its own once the signal is back', true);
  check(
    'and the worker is now on shift',
    /^\d:\d\d:\d\d$/.test((await page.locator('.elapsed').innerText()).trim()),
  );
  await shot(page, `ui-19-offline-synced.png`, true);
  await ctx.close();
}

// --- 8. Admin sees the offline punch flagged -------------------------------
console.log('\n=== On-site board and offline flag ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'On site' }).click();
  await page.getByText('Pat Doyle').first().waitFor({ timeout: 20000 });
  check('the on-site board shows who is clocked in', true);
  check(
    'with a live running timer',
    /\d+:\d\d:\d\d/.test(await page.locator('.row-head .pill').first().innerText()),
  );
  check(
    'and flags the punch as synced from offline',
    await page.getByText(/Saved offline/i).first().isVisible(),
  );
  await shot(page, `ui-20-on-site.png`, true);
  await ctx.close();
}

// --- 9. The job site map ----------------------------------------------------
console.log('\n=== Job site map ===');
{
  const { ctx, page } = await newPage({ geo: { ...SITE, accuracy: 12 } });
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Job sites' }).click();
  await page.getByRole('button', { name: '+ Add site' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '+ Add site' }).click();
  await page.waitForSelector('.modal', { timeout: 15000 });

  await page.locator('.sitemap.leaflet-container').waitFor({ timeout: 25000 });
  check('the map loads in the job site form', true);
  check(
    'address search is offered',
    await page.getByLabel('Find by address').isVisible(),
  );

  // Tapping the map must fill the coordinates in.
  const box = await page.locator('.sitemap').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const lat = await page.locator('#s-lat').inputValue();
  const lng = await page.locator('#s-lng').inputValue();
  check('tapping the map sets the coordinates', Number.isFinite(Number(lat)) && lat !== '' && lng !== '', `lat "${lat}" lng "${lng}"`);

  // And the geofence circle must be drawn to scale.
  await page.locator('#s-radius').fill('300');
  await page.waitForTimeout(500);
  check(
    'the boundary circle is drawn',
    (await page.locator('.sitemap .leaflet-overlay-pane path').count()) > 0,
  );
  await shot(page, `ui-21-site-map.png`, true);
  await ctx.close();
}

// --- 10. Worker cannot reach admin routes ----------------------------------
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
