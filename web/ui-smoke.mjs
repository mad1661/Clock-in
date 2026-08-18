/**
 * Browser smoke test for the real app, driven with Playwright against the
 * Firebase emulator suite.
 *
 *   npm run emulators          # in one terminal
 *   npm --prefix web run test:ui   # in another
 *
 * This drives the UI the way a person does — no seeding through a back door,
 * because with no Cloud Functions there is no back door: the app claims the
 * company, creates the worker and writes the punches itself, and the security
 * rules decide whether any of it is allowed. That makes this the test that
 * proves the whole thing actually works together.
 *
 * Geolocation is mocked per browser context, which is what lets us exercise
 * the cases that matter: on site, off site, and location switched off.
 *
 * Needs a FRESH emulator run — emulator data is in-memory and cleared on
 * restart, and the company can only be claimed once.
 */
import { chromium } from 'playwright';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';

const BASE = 'http://127.0.0.1:5000';
const SITE = { latitude: 51.5074, longitude: -0.1278 };
// ~1.4 km north: comfortably outside a 150 m fence.
const AWAY = { latitude: 51.52, longitude: -0.1278 };
const ADMIN = { email: 'boss@example.com', password: 'Password123!' };
const shots = process.env.SCREENSHOT_DIR || null;

// The app has no sign-up screen on purpose — the first administrator's login is
// created in the Firebase console. This is that step, and nothing more: every
// other action below goes through the UI and the security rules.
const provisioning = initializeApp({ apiKey: 'demo', projectId: 'demo-clockin', appId: '1:1:web:1' });
const provisioningAuth = getAuth(provisioning);
connectAuthEmulator(provisioningAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
await createUserWithEmailAndPassword(provisioningAuth, ADMIN.email, ADMIN.password);

let pass = 0;
let fail = 0;
const check = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n} ${extra}`);
  }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  // Everything this test talks to is on localhost. Without this, a proxy set in
  // the environment swallows the emulator traffic and Firestore writes die
  // mid-flight — which looks like a bug in the app rather than in the harness.
  args: ['--no-proxy-server'],
});

async function newPage({ geo, permissions = ['geolocation'] } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ...(geo ? { geolocation: geo } : {}),
    permissions,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 160));

  });
  page.on('pageerror', (e) => console.log('    [pageerror]', String(e).slice(0, 200)));
  return { ctx, page };
}

/** Reports what was actually on screen instead of a bare selector timeout. */
async function expectVisible(page, locator, what) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 25000 });
  } catch {
    const body = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 900);
    const get = async (c) => {
      const r = await fetch(
        `http://127.0.0.1:8080/v1/projects/demo-clockin/databases/(default)/documents/${c}`,
        { headers: { Authorization: 'Bearer owner' } },
      );
      return (await r.text()).replace(/\s+/g, ' ').slice(0, 250);
    };
    throw new Error(
      `Never saw ${what} at ${page.url()}\n  screen: ${body}` +
        `\n  users: ${await get('users')}\n  config: ${await get('config')}`,
    );
  }
}

async function shot(page, name, fullPage = false) {
  if (shots) await page.screenshot({ path: `${shots}/${name}`, fullPage });
}

async function signIn(page, email, password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

/**
 * Opens an admin section by tapping its link, the way a person does.
 *
 * Deliberately NOT a page reload: reloading tears down Firestore's write stream,
 * which would abort a punch or a profile write still in flight and make this
 * test fail for a reason no real user would ever hit.
 *
 * Retries once, because the hand-off from the setup screen to the clock page
 * can land on top of the first tap.
 */
async function openAdmin(page, label, path) {
  const link = page.getByRole('link', { name: label });
  await link.waitFor({ state: 'visible', timeout: 30000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await link.click();
    try {
      // Pathname only: the ticket page keeps the site and date in the query
      // string so a ticket can be linked to directly.
      await page.waitForURL((url) => url.pathname === path, { timeout: 5000 });
      return;
    } catch {
      /* the post-setup redirect beat us to it; tap again */
    }
  }
  const body = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 300);
  throw new Error(`Could not open ${path}; stuck at ${page.url()}\n  screen: ${body}`);
}

// The rules allow one punch per worker every 30 seconds. Real crews are never
// near that; back-to-back test scenarios are.
const RATE_LIMIT_MS = 31000;

/** Clicks the clock button and waits for the outcome banner, or reports why not. */
async function punch(page, action) {
  await page.getByRole('button', { name: new RegExp(`clock ${action}`, 'i') }).click();
  const banner = page.getByText(action === 'in' ? /Clocked in/i : /Clocked out/i);
  await expectVisible(page, banner, `the "Clocked ${action}" confirmation`);
}

/**
 * Chooses the job site, opening the pickers first if the clock screen has
 * collapsed them into the one-line summary — which it does once there is
 * nothing left to choose.
 */
async function selectSite(page, name) {
  // Either the pickers or the collapsed summary means the screen is ready.
  await page.locator('.chosen, #site').first().waitFor({ state: 'visible', timeout: 30000 });
  const change = page.getByRole('button', { name: /^change$/i });
  if (await change.isVisible().catch(() => false)) await change.click();
  await page.locator('#site').waitFor({ state: 'visible', timeout: 15000 });
  const value = await page
    .locator('#site')
    .evaluate((el, n) => [...el.options].find((o) => o.text.includes(n))?.value, name);
  if (!value) throw new Error(`Job site "${name}" not offered in the picker`);
  await page.selectOption('#site', value);
}

// --- 1. The very first person claims the company ----------------------------
console.log('\n=== The first person to arrive becomes the administrator ===');
let workerPassword;
{
  const { ctx, page } = await newPage();
  await signIn(page, ADMIN.email, ADMIN.password);

  await page.waitForSelector('text=/Make me the administrator/i', { timeout: 30000 });
  await page.fill('#name', 'The Boss');
  await shot(page, 'ui-1-setup.png', true);
  await page.getByRole('button', { name: /make me the administrator/i }).click();

  // The admin nav only appears once the profile write has been confirmed by the
  // server, so this doubles as the check that the bootstrap actually stuck.
  await page.getByRole('link', { name: /^job sites$/i }).waitFor({ state: 'visible', timeout: 30000 });
  check('company claimed and admin created', true);

  await openAdmin(page, /^job sites$/i, '/admin/sites');

  // --- 2. Add a job site ---
  console.log('\n=== Administrator adds a job site ===');
  const addSite = page.getByRole('button', { name: /add site/i });
  await expectVisible(page, addSite, 'the "Add site" button');
  await addSite.click();
  await page.fill('#s-name', 'Harbour Works');
  await page.fill('#s-address', '12 Dock Street');
  await page.fill('#s-lat', String(SITE.latitude));
  await page.fill('#s-lng', String(SITE.longitude));
  await page.fill('#s-radius', '150');
  await page.getByRole('button', { name: /save|create/i }).last().click();
  await page.waitForSelector('text=Harbour Works', { timeout: 15000 });
  check('job site created', true);
  await shot(page, 'ui-2-jobsite.png', true);

  // --- 2b. Add a machine and put it on the job ---
  console.log('\n=== Administrator builds the equipment list ===');
  await openAdmin(page, /^equipment$/i, '/admin/equipment');
  const addMachine = page.getByRole('button', { name: /add machine/i });
  await expectVisible(page, addMachine, 'the "Add machine" button');
  await addMachine.click();
  await page.fill('#e-type', 'D8T');
  await page.fill('#e-no', '2');
  await page.fill('#e-rate', '185');
  // Scoped to the dialog: the page behind it has a button with the same name,
  // and clicking that one lands on the modal backdrop instead.
  await page.getByRole('dialog').getByRole('button', { name: /add machine/i }).click();
  await expectVisible(page, page.getByText('D8T-2'), 'the new machine in the list');
  check('machine added to the yard list', true);

  await openAdmin(page, /^job sites$/i, '/admin/sites');
  await page.getByRole('button', { name: /^edit$/i }).first().click();
  await expectVisible(page, page.locator('#s-customer'), 'the site form');
  await page.fill('#s-customer', 'CEI');
  const dialog = page.getByRole('dialog');
  await dialog.locator('label', { hasText: 'D8T-2' }).locator('input[type=checkbox]').check();
  await dialog.getByRole('button', { name: /save changes/i }).click();
  await page.waitForTimeout(1500);
  check('machine assigned to the job site', true);

  // --- 2c. The activity log records what has happened so far ---
  console.log('\n=== The activity log ===');
  await openAdmin(page, /^activity$/i, '/admin/activity');
  await expectVisible(page, page.getByText(/Machine added or edited/i), 'the equipment entry');
  const activity = await page.locator('.list').innerText();
  check(
    'changes are logged with who made them',
    activity.includes('boss@example.com') && activity.includes('Job site added'),
    activity.replace(/\n/g, ' | ').slice(0, 200),
  );

  // --- 3. Add a worker ---
  console.log('\n=== Administrator adds an employee ===');
  await openAdmin(page, /^workers$/i, '/admin/workers');
  const addWorker = page.getByRole('button', { name: /add employee/i });
  await expectVisible(page, addWorker, 'the "Add employee" button');
  await addWorker.click();
  await page.fill('#w-name', 'Pat Doyle');
  await page.fill('#w-email', 'pat@example.com');
  await page.fill('#w-wage', '38.50');
  // Give them their usual machine, so the clock screen can pick it for them.
  await page
    .getByRole('dialog')
    .locator('label', { hasText: 'D8T-2' })
    .locator('input[type=checkbox]')
    .check();
  await page.getByRole('button', { name: /create account/i }).click();

  // The generated password itself, not the words "one-time password" — that
  // phrase also appears as a hint on the form before anything is submitted.
  const credential = page.locator('.credential .mono');
  await expectVisible(page, credential, 'the generated password');
  workerPassword = await credential.innerText();
  check('one-time password issued', Boolean(workerPassword && workerPassword.length >= 10));
  await shot(page, 'ui-3-credential.png', true);
  await page.getByRole('button', { name: /^done$/i }).click();

  // --- 3b. Ownership ---
  console.log('\n=== Ownership ===');
  await openAdmin(page, /^workers$/i, '/admin/workers');
  const roster = await page.locator('.list').innerText();
  check('the owner is marked as such', roster.includes('Owner'), roster.replace(/\n/g, ' | ').slice(0, 160));
  // Pat is a worker, not a supervisor, so ownership is not offered for them.
  check(
    'ownership is not offered to a plain worker',
    (await page.getByRole('button', { name: /make owner/i }).count()) === 0,
  );

  await ctx.close();
}

// --- 4. Worker on site clocks in clean --------------------------------------
console.log('\n=== Worker standing on site clocks in and out ===');
{
  const { ctx, page } = await newPage({ geo: SITE });
  await signIn(page, 'pat@example.com', workerPassword);

  // One site, and a machine assigned to them, so there is nothing left to
  // choose: the screen should show the choice back as a line, not two pickers.
  const chosen = page.locator('.chosen');
  await expectVisible(page, chosen, 'the settled site and machine');
  const summary = await chosen.innerText();
  check(
    'their usual machine is picked for them',
    summary.includes('Harbour Works') && summary.includes('D8T-2'),
    `line read "${summary.replace(/\n/g, ' ')}"`,
  );
  await shot(page, 'ui-4-clock.png', true);

  // …and Change still opens the pickers for a day that is not typical.
  await page.getByRole('button', { name: /^change$/i }).click();
  await expectVisible(page, page.locator('#machine'), 'the machine picker after Change');
  check('the choice can still be changed', true);

  await punch(page, 'in');
  check('clocked in', true);
  check(
    'location confirmed, not flagged',
    await page.getByText(/Location confirmed/i).isVisible(),
  );
  await shot(page, 'ui-5-clocked-in.png', true);

  await page.waitForTimeout(RATE_LIMIT_MS);
  await expectVisible(page, page.locator('#hours'), 'the hour-meter field');
  await page.fill('#hours', '6.5');
  await punch(page, 'out');
  check('clocked out with an hour-meter reading', true);
  await shot(page, 'ui-6-clocked-out.png', true);

  await ctx.close();
}

// --- 5. Worker away from site is recorded, flagged --------------------------
console.log('\n=== Worker away from the site is recorded but flagged ===');
{
  const { ctx, page } = await newPage({ geo: AWAY });
  await signIn(page, 'pat@example.com', workerPassword);
  await selectSite(page, 'Harbour Works');

  await page.waitForTimeout(RATE_LIMIT_MS);
  await punch(page, 'in');
  // The whole point: hours are never refused, they are flagged.
  check(
    'hours recorded despite being off site',
    await page.getByText(/could not confirm you were on site/i).isVisible(),
  );
  await shot(page, 'ui-7-flagged.png', true);

  await page.waitForTimeout(RATE_LIMIT_MS);
  await punch(page, 'out');
  await ctx.close();
}

// --- 6. Location switched off is still not a refusal ------------------------
console.log('\n=== Location switched off ===');
{
  const { ctx, page } = await newPage({ permissions: [] });
  await signIn(page, 'pat@example.com', workerPassword);
  await selectSite(page, 'Harbour Works');

  await page.waitForTimeout(RATE_LIMIT_MS);
  await punch(page, 'in');
  check('clocked in with no location at all', true);
  check(
    'told why it needs approval',
    await page.getByText(/could not confirm you were on site/i).isVisible(),
  );
  await shot(page, 'ui-8-no-location.png', true);

  // Clock out too, so the supervisor has a closed shift to actually rule on.
  await page.waitForTimeout(RATE_LIMIT_MS);
  await punch(page, 'out');
  await ctx.close();
}

// --- 7. The supervisor sees the flagged shifts ------------------------------
console.log('\n=== Supervisor reviews what came in ===');
{
  const { ctx, page } = await newPage({ geo: SITE });
  await signIn(page, ADMIN.email, ADMIN.password);
  await openAdmin(page, /^review$/i, '/admin/review');
  check('navigation bar works', true);

  await page.waitForSelector('text=Pat Doyle', { timeout: 20000 });
  check('flagged shifts reached the review queue', true);
  await shot(page, 'ui-9-review.png', true);

  // The decision lives in a modal behind the row's own "Review" button.
  await page.getByRole('button', { name: /^review$/i }).first().click();
  const approve = page.getByRole('button', { name: /^approve$/i });
  await expectVisible(page, approve, 'the Approve button');
  await approve.click();
  // Two shifts were flagged (off site, and no location at all), so approving
  // one leaves exactly one behind.
  await expectVisible(page, page.getByText(/Needs review \(1\)/), 'the queue dropping to one');
  check('supervisor approved a shift', true);
  await ctx.close();
}

// --- 8. The rental ticket builds itself ------------------------------------
console.log('\n=== The daily rental ticket ===');
{
  const { ctx, page } = await newPage({ geo: SITE });
  await signIn(page, ADMIN.email, ADMIN.password);
  await openAdmin(page, /^rental ticket$/i, '/admin/ticket');

  await expectVisible(page, page.locator('.ticket-table'), 'the rental ticket');
  const row = page.locator('.ticket-table tbody tr').first();
  const cells = await row.locator('td').allInnerTexts();
  check('operator is on the ticket', cells[3].includes('Pat Doyle'), cells.join(' | '));
  check('machine is on the ticket', cells[0].includes('D8T') && cells[1].includes('2'), cells.join(' | '));

  // Two stints either side of the break become the form's two in/out pairs.
  check('both time pairs filled in', Boolean(cells[4] && cells[5]), cells.join(' | '));

  // The hour meter the operator typed is carried through.
  const meter = await row.locator('input[type=number]').inputValue();
  check('hour-meter reading carried onto the ticket', meter === '6.5', `got ${meter}`);

  await page.fill('#t-comments', 'D8T-2 had no GPS at 7am.');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expectVisible(page, page.getByText(/^Saved\.$/), 'the save confirmation');

  const number = await page.locator('.ticket-no').innerText();
  check('ticket number allocated', /^\d+$/.test(number.trim()), `got "${number}"`);
  await shot(page, 'ui-10-ticket.png', true);

  // The bug this guards: window.print() blocks, so a busy state set immediately
  // before it is committed but never painted, and the screen just freezes. Stub
  // print and record whether the overlay had made it onto the page by the time
  // the browser would have stopped repainting.
  await page.evaluate(() => {
    window.__printed = false;
    window.__overlayAtPrint = false;
    window.print = () => {
      window.__printed = true;
      window.__overlayAtPrint = Boolean(document.querySelector('.print-status'));
    };
  });
  await page.getByRole('button', { name: /print \/ pdf/i }).click();
  await page.waitForFunction(() => window.__printed === true, { timeout: 15000 });
  check(
    'the loading graphic is on the page before the browser blocks',
    await page.evaluate(() => window.__overlayAtPrint),
  );

  // It must NOT clear just because print() returned — Safari returns straight
  // away and keeps building the sheet, which is what made it flash and vanish.
  await page.waitForTimeout(1200);
  check(
    'it stays up while the sheet is still being built',
    await page.locator('.print-status').isVisible(),
  );

  // Only the dialog closing takes it down.
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.waitForFunction(() => !document.querySelector('.print-status'), { timeout: 15000 });
  check('it clears once printing is finished', true);

  // --- 9. The supervisor signs it ---
  console.log('\n=== Supervisor signs the ticket ===');
  await page.getByRole('button', { name: /tap to sign|sign off/i }).first().click();
  const pad = page.locator('.sig-pad');
  await expectVisible(page, pad, 'the signature pad');

  // Draw something with a real pointer, the way a finger or stylus would.
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    await page.mouse.move(
      box.x + box.width * (0.2 + 0.6 * t),
      box.y + box.height * (0.6 - Math.sin(t * Math.PI) * 0.3),
    );
  }
  await page.mouse.up();

  await page.getByRole('button', { name: /sign and save/i }).click();
  await expectVisible(page, page.locator('.signature-mark'), 'the signature on the ticket');
  check('signature captured and shown on the ticket', true);

  const signedBy = await page.locator('.ticket-sign-name').innerText();
  check('signature is attributed', signedBy.includes('The Boss'), `read "${signedBy}"`);
  await shot(page, 'ui-11-signed.png', true);

  // Editing the sheet after signing must not leave the mark standing against
  // figures the supervisor never saw.
  await page.fill('#t-comments', 'Added after signing.');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expectVisible(page, page.getByText(/needs signing again/i), 'the re-sign warning');
  check('editing a signed ticket clears the signature', (await page.locator('.signature-mark').count()) === 0);

  // --- 10. Taking a signature back off ---
  console.log('\n=== Clearing a signature ===');
  page.on('dialog', (d) => void d.accept());

  await page.getByRole('button', { name: /tap to sign|sign off/i }).first().click();
  const pad2 = page.locator('.sig-pad');
  await expectVisible(page, pad2, 'the signature pad');
  const box2 = await pad2.boundingBox();
  await page.mouse.move(box2.x + box2.width * 0.3, box2.y + box2.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width * 0.7, box2.y + box2.height * 0.4);
  await page.mouse.up();
  await page.getByRole('button', { name: /sign and save/i }).click();
  await expectVisible(page, page.locator('.signature-mark'), 'the second signature');

  await page.getByRole('button', { name: /clear signature/i }).click();
  await page.waitForFunction(() => document.querySelectorAll('.signature-mark').length === 0, {
    timeout: 15000,
  });
  check('a signature can be taken back off entirely', true);
  check(
    'clearing takes the name with it',
    (await page.locator('.ticket-sign-name').count()) === 0,
  );

  // --- 11. A stored signature, applied with one tap ---
  console.log('\n=== Supervisor stores their signature ===');
  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  const addSig = page.getByRole('button', { name: /add my signature|replace signature/i });
  await expectVisible(page, addSig, 'the signature card on Account');
  await addSig.click();

  const pad3 = page.locator('.sig-pad');
  await expectVisible(page, pad3, 'the signature pad on Account');
  const box3 = await pad3.boundingBox();
  await page.mouse.move(box3.x + box3.width * 0.25, box3.y + box3.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box3.x + box3.width * 0.75, box3.y + box3.height * 0.45);
  await page.mouse.up();
  await page.getByRole('button', { name: /save signature/i }).click();
  await expectVisible(page, page.locator('.saved-signature .signature-mark'), 'the stored signature');
  check('a supervisor can store their signature', true);

  // …and it is offered on the ticket instead of drawing again.
  await page.goto(`${BASE}/admin/ticket`, { waitUntil: 'domcontentloaded' });
  await expectVisible(page, page.locator('.ticket-table'), 'the ticket');
  await page.getByRole('button', { name: /tap to sign|sign off/i }).first().click();
  const useSaved = page.getByRole('button', { name: /use my saved signature/i });
  await expectVisible(page, useSaved, 'the saved-signature shortcut');
  await useSaved.click();
  await expectVisible(page, page.locator('.ticket-sign .signature-mark'), 'the applied signature');
  check('the stored signature signs a ticket in one tap', true);

  await ctx.close();
}

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
