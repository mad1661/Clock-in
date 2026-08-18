/**
 * Security rules tests.
 *
 * With no Cloud Functions, firestore.rules IS the server. Every guarantee the
 * app makes — you cannot clock in twice, you cannot mark your own punch clean,
 * you cannot read someone else's hours, you cannot make yourself an admin —
 * lives in that file and nowhere else. So it gets tested against the real
 * Firestore emulator rather than reasoned about.
 *
 * Run with:  npm test
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '..', 'firestore.rules'), 'utf8');

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-clockin',
  firestore: { rules, host: '127.0.0.1', port: 8080 },
});

// --- Fixtures --------------------------------------------------------------

// Chino, CA. metersPerDegLng is what an admin's browser computes and stores,
// because rules have no cos().
const SITE = {
  id: 'site1',
  name: 'Chino Yard',
  address: '1 Yard Rd',
  lat: 34.0122,
  lng: -117.6889,
  radiusMeters: 100,
  metersPerDegLng: 111320 * Math.cos((34.0122 * Math.PI) / 180),
  active: true,
};

/** A point `meters` due north of the site — the cheap way to land off-fence. */
function north(meters) {
  return { lat: SITE.lat + meters / 111320, lng: SITE.lng };
}

function punch(overrides = {}) {
  const { location, ...rest } = overrides;
  return {
    at: serverTimestamp(),
    method: 'gps',
    jobSiteId: SITE.id,
    jobSiteName: SITE.name,
    location:
      location === null
        ? null
        : {
            lat: SITE.lat,
            lng: SITE.lng,
            accuracy: 12,
            capturedAt: Timestamp.now(),
            ...location,
          },
    locationError: null,
    site: { lat: SITE.lat, lng: SITE.lng, radiusMeters: SITE.radiusMeters },
    distanceMeters: 3,
    withinGeofence: true,
    photoPath: null,
    device: { label: 'iPhone', platform: 'iOS' },
    note: null,
    offline: null,
    ...rest,
  };
}

function shiftDoc(uid, overrides = {}) {
  return {
    userId: uid,
    userDisplayName: 'Test',
    userEmail: 'test@example.com',
    jobSiteId: SITE.id,
    jobSiteName: SITE.name,
    status: 'open',
    clockIn: punch(),
    clockOut: null,
    clockInAt: serverTimestamp(),
    clockOutAt: null,
    durationMinutes: null,
    needsReview: false,
    flags: [],
    review: { status: 'approved', by: null, at: null, note: null },
    pendingEdit: null,
    hasPendingEdit: false,
    lastEdit: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

const seed = (fn) => testEnv.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

/** Signed in, with an employee profile already on file. */
async function asUser(uid, profile = {}) {
  await seed((db) =>
    setDoc(doc(db, 'users', uid), {
      uid,
      email: `${uid}@example.com`,
      displayName: uid,
      role: 'worker',
      active: true,
      jobSiteIds: [],
      mustChangePassword: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...profile,
    }),
  );
  return testEnv.authenticatedContext(uid).firestore();
}

const asAdmin = (uid = 'boss') => asUser(uid, { role: 'admin' });

async function reset() {
  await testEnv.clearFirestore();
}

/** The company already claimed, plus one active job site. */
async function establishedCompany() {
  await seed(async (db) => {
    await setDoc(doc(db, 'config', 'company'), {
      ownerUid: 'boss',
      name: 'Coburn Equipment Rentals',
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'jobSites', SITE.id), { ...SITE, updatedAt: serverTimestamp() });
  });
}

/**
 * Clock in the way the app does: shift + clock-state in one batch. Returns the
 * promise so a test can assert it succeeds or fails.
 */
function clockIn(db, uid, { needsReview = false, clockIn: clockInPunch, shiftId } = {}) {
  const ref = shiftId ? doc(db, 'shifts', shiftId) : doc(collection(db, 'shifts'));
  const state = doc(db, 'userState', uid);
  const batch = writeBatch(db);
  batch.set(ref, shiftDoc(uid, { needsReview, clockIn: clockInPunch ?? punch() }));
  batch.set(state, { openShiftId: ref.id, lastPunchAt: serverTimestamp() });
  return Object.assign(batch.commit(), { id: ref.id });
}

// --- Bootstrap -------------------------------------------------------------

test('the first person to arrive can claim the company and become admin', async () => {
  await reset();
  const db = testEnv.authenticatedContext('first').firestore();

  const batch = writeBatch(db);
  batch.set(doc(db, 'users', 'first'), {
    uid: 'first',
    email: 'first@example.com',
    displayName: 'First',
    role: 'admin',
    active: true,
    jobSiteIds: [],
    mustChangePassword: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'config', 'company'), {
    ownerUid: 'first',
    name: 'Coburn Equipment Rentals',
    createdAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
});

test('an admin profile without the company document in the same batch is refused', async () => {
  await reset();
  const db = testEnv.authenticatedContext('sneak').firestore();
  await assertFails(
    setDoc(doc(db, 'users', 'sneak'), {
      uid: 'sneak',
      email: 'sneak@example.com',
      displayName: 'Sneak',
      role: 'admin',
      active: true,
      jobSiteIds: [],
      mustChangePassword: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
  );
});

test('the bootstrap works exactly once — the second person cannot claim it', async () => {
  await reset();
  await establishedCompany();

  const db = testEnv.authenticatedContext('second').firestore();
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', 'second'), {
    uid: 'second',
    email: 'second@example.com',
    displayName: 'Second',
    role: 'admin',
    active: true,
    jobSiteIds: [],
    mustChangePassword: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'config', 'company'), {
    ownerUid: 'second',
    name: 'Hostile Takeover',
    createdAt: serverTimestamp(),
  });
  await assertFails(batch.commit());
});

// --- Roles and profiles ----------------------------------------------------

test('a worker cannot promote themselves to admin', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertFails(updateDoc(doc(db, 'users', 'bob'), { role: 'admin', updatedAt: serverTimestamp() }));
});

test('a worker cannot reactivate themselves after being deactivated', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob', { active: false });
  await assertFails(updateDoc(doc(db, 'users', 'bob'), { active: true, updatedAt: serverTimestamp() }));
});

test('a worker may only clear their own temporary-password flag', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob', { mustChangePassword: true });
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'bob'), { mustChangePassword: false, updatedAt: serverTimestamp() }),
  );
});

test('a worker cannot read or list other employees', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => setDoc(doc(db, 'users', 'carol'), { uid: 'carol', role: 'worker', active: true }));
  const db = await asUser('bob');
  await assertFails(getDoc(doc(db, 'users', 'carol')));
  await assertFails(getDocs(collection(db, 'users')));
});

test('an admin can create employees and list them', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertSucceeds(
    setDoc(doc(db, 'users', 'newhire'), {
      uid: 'newhire',
      email: 'newhire@example.com',
      displayName: 'New Hire',
      role: 'worker',
      active: true,
      jobSiteIds: [],
      mustChangePassword: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
  );
  await assertSucceeds(getDocs(collection(db, 'users')));
});

test('a deactivated admin has no admin powers left', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('exboss', { role: 'admin', active: false });
  await assertFails(getDocs(collection(db, 'users')));
  await assertFails(
    setDoc(doc(db, 'jobSites', 'site2'), { ...SITE, id: 'site2', updatedAt: serverTimestamp() }),
  );
});

// --- Job sites -------------------------------------------------------------

test('a worker cannot move a job site to wherever they happen to be', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertFails(updateDoc(doc(db, 'jobSites', SITE.id), { lat: 0, lng: 0, updatedAt: serverTimestamp() }));
});

test('a job site cannot be given an absurd radius', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertFails(
    setDoc(doc(db, 'jobSites', 'huge'), {
      ...SITE,
      id: 'huge',
      radiusMeters: 500000,
      updatedAt: serverTimestamp(),
    }),
  );
});

test('job sites are retired, never deleted', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertSucceeds(updateDoc(doc(db, 'jobSites', SITE.id), { active: false, updatedAt: serverTimestamp() }));
});

// --- Clocking in -----------------------------------------------------------

test('a worker standing on site clocks in clean', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertSucceeds(clockIn(db, 'bob', { needsReview: false }));
});

test('the very first punch of a worker’s life is not blocked by the rate limit', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  // No clock-state document exists yet. Creating one and then updating it
  // would put lastPunchAt at `now` and immediately trip the 30-second limit,
  // so the first clock-in has to create it already naming the shift.
  let exists = true;
  await seed(async (d) => {
    exists = (await getDoc(doc(d, 'userState', 'bob'))).exists();
  });
  assert.equal(exists, false);
  await assertSucceeds(clockIn(db, 'bob'));
});

test('a second punch within 30 seconds is still rate limited', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertSucceeds(clockIn(db, 'bob'));
  // Close it out via the back door so only the rate limit is under test.
  await seed((d) => updateDoc(doc(d, 'userState', 'bob'), { openShiftId: null }));
  await assertFails(clockIn(db, 'bob'));
});

test('a worker on the fence line is flagged rather than refused', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  // Just outside the fence, and the client guessed "clean". The rules must not
  // accept that — but the flagged retry the app falls back to must go through,
  // or the worker simply cannot clock in.
  const borderline = punch({ location: { ...north(180), accuracy: 12 } });
  await assertFails(clockIn(db, 'bob', { needsReview: false, clockIn: borderline }));
  await assertSucceeds(
    clockIn(db, 'bob', { needsReview: true, clockIn: { ...borderline, method: 'unverified' } }),
  );
});

test('a punch from a mile away cannot be written as verified', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertFails(
    clockIn(db, 'bob', { needsReview: false, clockIn: punch({ location: north(1600) }) }),
  );
});

test('a punch from a mile away is accepted when it is flagged for review', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertSucceeds(
    clockIn(db, 'bob', {
      needsReview: true,
      clockIn: punch({ method: 'unverified', location: north(1600), withinGeofence: false }),
    }),
  );
});

test('a punch with no location at all is accepted, flagged', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertSucceeds(
    clockIn(db, 'bob', {
      needsReview: true,
      clockIn: punch({ method: 'unverified', location: null, withinGeofence: false }),
    }),
  );
});

test('a wildly imprecise fix cannot buy its way inside the fence', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  // 5 km out claiming a 10 km error radius. Slack is capped at 75 m.
  await assertFails(
    clockIn(db, 'bob', {
      needsReview: false,
      clockIn: punch({ location: { ...north(5000), accuracy: 10000 } }),
    }),
  );
});

test('a stale fix from hours ago cannot be replayed as a fresh punch', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertFails(
    clockIn(db, 'bob', {
      needsReview: false,
      clockIn: punch({
        location: { capturedAt: Timestamp.fromMillis(Date.now() - 3 * 60 * 60 * 1000) },
      }),
    }),
  );
});

test('a punch timestamped by the phone rather than the server is refused', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  const ref = doc(collection(db, 'shifts'));
  const batch = writeBatch(db);
  batch.set(ref, shiftDoc('bob', { clockInAt: Timestamp.fromMillis(Date.now() - 4 * 3600 * 1000) }));
  batch.set(doc(db, 'userState', 'bob'), { openShiftId: ref.id, lastPunchAt: serverTimestamp() });
  await assertFails(batch.commit());
});

test('a worker cannot clock in against an inactive job site', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => updateDoc(doc(db, 'jobSites', SITE.id), { active: false }));
  const db = await asUser('bob');
  await assertFails(clockIn(db, 'bob'));
});

test('a worker cannot clock in as somebody else', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => setDoc(doc(db, 'users', 'carol'), { uid: 'carol', role: 'worker', active: true }));
  const db = await asUser('bob');
  const ref = doc(collection(db, 'shifts'));
  const batch = writeBatch(db);
  batch.set(ref, shiftDoc('carol'));
  batch.set(doc(db, 'userState', 'carol'), { openShiftId: ref.id, lastPunchAt: serverTimestamp() });
  await assertFails(batch.commit());
});

test('a deactivated worker cannot clock in', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob', { active: false });
  await assertFails(clockIn(db, 'bob'));
});

test('a shift written without the matching clock-state update is refused', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  // The lone shift write is the whole attack: no userState means no proof that
  // another shift wasn't already open.
  await assertFails(setDoc(doc(collection(db, 'shifts')), shiftDoc('bob')));
});

test('a worker cannot open a second shift while one is already open', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertSucceeds(clockIn(db, 'bob'));

  const ref = doc(collection(db, 'shifts'));
  const batch = writeBatch(db);
  batch.set(ref, shiftDoc('bob'));
  batch.update(doc(db, 'userState', 'bob'), { openShiftId: ref.id, lastPunchAt: serverTimestamp() });
  await assertFails(batch.commit());
});

// --- Clocking out ----------------------------------------------------------

async function openShiftFor(uid, extra = {}) {
  let id;
  await seed(async (db) => {
    const ref = doc(collection(db, 'shifts'));
    id = ref.id;
    await setDoc(ref, shiftDoc(uid, extra));
    await setDoc(doc(db, 'userState', uid), {
      openShiftId: ref.id,
      // Well in the past so the 30-second rate limit is not what is under test.
      lastPunchAt: Timestamp.fromMillis(Date.now() - 3600 * 1000),
    });
  });
  return id;
}

function clockOut(db, uid, shiftId, { needsReview = false, clockOut: out } = {}) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'shifts', shiftId), {
    status: 'closed',
    clockOut: out ?? punch(),
    clockOutAt: serverTimestamp(),
    needsReview,
    flags: [],
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'userState', uid), { openShiftId: null, lastPunchAt: serverTimestamp() });
  return batch.commit();
}

test('a worker clocks out of their own open shift', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob');
  const db = await asUser('bob');
  await assertSucceeds(clockOut(db, 'bob', shiftId));
});

test('a shift flagged at clock-in stays flagged after a clean clock-out', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { needsReview: true });
  const db = await asUser('bob');
  // Trying to launder the flag away by clocking out from inside the fence.
  await assertFails(clockOut(db, 'bob', shiftId, { needsReview: false }));
  await assertSucceeds(clockOut(db, 'bob', shiftId, { needsReview: true }));
});

test('a worker cannot clock out of somebody else’s shift', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('carol');
  await seed((db) => setDoc(doc(db, 'users', 'carol'), { uid: 'carol', role: 'worker', active: true }));
  const db = await asUser('bob');
  await assertFails(clockOut(db, 'bob', shiftId));
});

test('clocking out cannot rewrite the clock-in that was recorded', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob');
  const db = await asUser('bob');
  const batch = writeBatch(db);
  batch.update(doc(db, 'shifts', shiftId), {
    status: 'closed',
    clockIn: punch({ location: north(1600) }),
    clockOut: punch(),
    clockOutAt: serverTimestamp(),
    needsReview: false,
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'userState', 'bob'), { openShiftId: null, lastPunchAt: serverTimestamp() });
  await assertFails(batch.commit());
});

test('a shift opened before flags existed can still be clocked out', async () => {
  await reset();
  await establishedCompany();
  // Stripped back to how a record written before flags existed actually looks.
  const shiftId = await openShiftFor('bob');
  const { deleteField } = await import('firebase/firestore');
  await seed((d) => updateDoc(doc(d, 'shifts', shiftId), { flags: deleteField() }));
  const db = await asUser('bob');
  await assertSucceeds(clockOut(db, 'bob', shiftId));
});

test('clocking out cannot erase the flags the clock-in earned', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { needsReview: true, flags: ['OUTSIDE_GEOFENCE'] });
  const db = await asUser('bob');
  const batch = writeBatch(db);
  batch.update(doc(db, 'shifts', shiftId), {
    status: 'closed',
    clockOut: punch(),
    clockOutAt: serverTimestamp(),
    needsReview: true,
    flags: [],
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'userState', 'bob'), { openShiftId: null, lastPunchAt: serverTimestamp() });
  await assertFails(batch.commit());
});

test('a closed shift cannot be reopened to keep the clock running', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { status: 'closed', clockOutAt: serverTimestamp() });
  const db = await asUser('bob');
  await assertFails(
    updateDoc(doc(db, 'shifts', shiftId), { status: 'open', updatedAt: serverTimestamp() }),
  );
});

// --- Reading hours ---------------------------------------------------------

test('a worker sees their own hours and nobody else’s', async () => {
  await reset();
  await establishedCompany();
  await openShiftFor('bob');
  await openShiftFor('carol');
  const db = await asUser('bob');

  await assertSucceeds(getDocs(query(collection(db, 'shifts'), where('userId', '==', 'bob'))));
  // The whole collection, and a query aimed at a colleague, are both refused.
  await assertFails(getDocs(collection(db, 'shifts')));
  await assertFails(getDocs(query(collection(db, 'shifts'), where('userId', '==', 'carol'))));
});

test('an admin sees the whole timesheet', async () => {
  await reset();
  await establishedCompany();
  await openShiftFor('bob');
  const db = await asAdmin();
  await assertSucceeds(getDocs(collection(db, 'shifts')));
});

// --- Edits and approval ----------------------------------------------------

test('a worker cannot simply rewrite their hours', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { status: 'closed', clockOutAt: serverTimestamp() });
  const db = await asUser('bob');
  await assertFails(
    updateDoc(doc(db, 'shifts', shiftId), {
      clockInAt: Timestamp.fromMillis(Date.now() - 9 * 3600 * 1000),
      durationMinutes: 540,
      updatedAt: serverTimestamp(),
    }),
  );
});

test('a worker can request a correction, which only records the request', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { status: 'closed', clockOutAt: serverTimestamp() });
  const db = await asUser('bob');
  await assertSucceeds(
    updateDoc(doc(db, 'shifts', shiftId), {
      hasPendingEdit: true,
      pendingEdit: {
        requestedAt: serverTimestamp(),
        requestedClockInAt: Timestamp.fromMillis(Date.now() - 9 * 3600 * 1000),
        requestedClockOutAt: Timestamp.now(),
        reason: 'Forgot to clock in this morning',
      },
      updatedAt: serverTimestamp(),
    }),
  );
});

test('a correction request cannot smuggle a time change alongside it', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { status: 'closed', clockOutAt: serverTimestamp() });
  const db = await asUser('bob');
  await assertFails(
    updateDoc(doc(db, 'shifts', shiftId), {
      hasPendingEdit: true,
      pendingEdit: { reason: 'x', requestedAt: serverTimestamp() },
      clockInAt: Timestamp.fromMillis(Date.now() - 9 * 3600 * 1000),
      updatedAt: serverTimestamp(),
    }),
  );
});

test('a worker cannot approve their own flagged shift', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', {
    status: 'closed',
    clockOutAt: serverTimestamp(),
    needsReview: true,
  });
  const db = await asUser('bob');
  await assertFails(
    updateDoc(doc(db, 'shifts', shiftId), {
      needsReview: false,
      review: { status: 'approved', by: 'bob', at: serverTimestamp(), note: null },
      updatedAt: serverTimestamp(),
    }),
  );
});

test('a supervisor approves a flagged shift and can adjust the times', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', {
    status: 'closed',
    clockOutAt: serverTimestamp(),
    needsReview: true,
  });
  const db = await asAdmin();
  await assertSucceeds(
    updateDoc(doc(db, 'shifts', shiftId), {
      clockInAt: Timestamp.fromMillis(Date.now() - 8 * 3600 * 1000),
      durationMinutes: 480,
      needsReview: false,
      review: { status: 'approved', by: 'boss', at: serverTimestamp(), note: 'Confirmed by phone' },
      updatedAt: serverTimestamp(),
    }),
  );
});

test('even a supervisor cannot rewrite where the worker actually was', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob', { status: 'closed', clockOutAt: serverTimestamp() });
  const db = await asAdmin();
  await assertFails(
    updateDoc(doc(db, 'shifts', shiftId), {
      clockIn: punch({ location: north(1600) }),
      updatedAt: serverTimestamp(),
    }),
  );
});

test('nobody can delete a shift', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob');
  const admin = await asAdmin();
  const worker = await asUser('bob');
  const { deleteDoc } = await import('firebase/firestore');
  await assertFails(deleteDoc(doc(admin, 'shifts', shiftId)));
  await assertFails(deleteDoc(doc(worker, 'shifts', shiftId)));
});

// --- Stuck shifts ----------------------------------------------------------

test('an admin can free a worker whose shift is stuck open', async () => {
  await reset();
  await establishedCompany();
  const shiftId = await openShiftFor('bob');
  const db = await asAdmin();
  const batch = writeBatch(db);
  batch.update(doc(db, 'shifts', shiftId), {
    status: 'closed',
    clockOutAt: serverTimestamp(),
    durationMinutes: 0,
    needsReview: true,
    review: { status: 'pending', by: null, at: null, note: 'Forgot to clock out' },
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'userState', 'bob'), { openShiftId: null });
  await assertSucceeds(batch.commit());
});

// --- Equipment ---------------------------------------------------------------

const machine = (over = {}) => ({
  id: 'd8t2',
  type: 'D8T',
  machineNo: '2',
  description: '',
  active: true,
  updatedAt: serverTimestamp(),
  ...over,
});

test('an admin keeps the machine list', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertSucceeds(setDoc(doc(db, 'equipment', 'd8t2'), machine()));
  await assertSucceeds(
    updateDoc(doc(db, 'equipment', 'd8t2'), { active: false, updatedAt: serverTimestamp() }),
  );
});

test('a worker can read the machine list but not change it', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => setDoc(doc(db, 'equipment', 'd8t2'), machine()));
  const db = await asUser('bob');
  // They need to read it: the clock screen offers them the machine they are on.
  await assertSucceeds(getDocs(collection(db, 'equipment')));
  await assertFails(setDoc(doc(db, 'equipment', 'sneaky'), machine({ id: 'sneaky' })));
  await assertFails(
    updateDoc(doc(db, 'equipment', 'd8t2'), { type: 'D11', updatedAt: serverTimestamp() }),
  );
});

test('a machine is retired, never deleted', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => setDoc(doc(db, 'equipment', 'd8t2'), machine()));
  const db = await asAdmin();
  const { deleteDoc } = await import('firebase/firestore');
  await assertFails(deleteDoc(doc(db, 'equipment', 'd8t2')));
});

test('a machine needs a type', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertFails(setDoc(doc(db, 'equipment', 'blank'), machine({ id: 'blank', type: '' })));
});

// --- Daily rental tickets ----------------------------------------------------

const ticket = (over = {}) => ({
  id: `${SITE.id}_2026-08-03`,
  ticketNumber: 60516,
  jobSiteId: SITE.id,
  jobSiteName: SITE.name,
  customer: 'CEI',
  location: 'N. Fontana',
  jobNumber: '',
  date: '2026-08-03',
  rows: [],
  comments: '',
  supervisorName: null,
  signedAt: null,
  updatedAt: serverTimestamp(),
  ...over,
});

test('a supervisor writes the rental ticket', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertSucceeds(setDoc(doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`), ticket()));
  await assertSucceeds(getDocs(collection(db, 'dailyTickets')));
});

test('a worker cannot read or write the customer’s billing ticket', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => setDoc(doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`), ticket()));
  const db = await asUser('bob');
  await assertFails(getDocs(collection(db, 'dailyTickets')));
  await assertFails(getDoc(doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`)));
  await assertFails(
    updateDoc(doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`), {
      rows: [],
      updatedAt: serverTimestamp(),
    }),
  );
});

test('a ticket cannot be back-dated by the client clock', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertFails(
    setDoc(
      doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`),
      ticket({ updatedAt: Timestamp.fromMillis(Date.now() - 86400000) }),
    ),
  );
});

test('a ticket cannot be deleted once it exists', async () => {
  await reset();
  await establishedCompany();
  await seed((db) => setDoc(doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`), ticket()));
  const db = await asAdmin();
  const { deleteDoc } = await import('firebase/firestore');
  await assertFails(deleteDoc(doc(db, 'dailyTickets', `${SITE.id}_2026-08-03`)));
});

// --- Audit -----------------------------------------------------------------

test('the audit trail is append-only and cannot be edited by its own author', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  const ref = doc(collection(db, 'auditLogs'));
  await assertSucceeds(
    setDoc(ref, {
      action: 'worker.create',
      actorUid: 'boss',
      actorEmail: 'boss@example.com',
      targetUserId: 'bob',
      targetId: null,
      details: {},
      at: serverTimestamp(),
    }),
  );
  await assertFails(updateDoc(doc(db, 'auditLogs', ref.id), { action: 'nothing.happened' }));
});

test('an entry cannot be written in someone else’s name', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertFails(
    setDoc(doc(collection(db, 'auditLogs')), {
      action: 'shift.review',
      actorUid: 'boss',
      at: serverTimestamp(),
    }),
  );
});

test('a worker cannot read the audit trail', async () => {
  await reset();
  await establishedCompany();
  const db = await asUser('bob');
  await assertFails(getDocs(collection(db, 'auditLogs')));
});

// --- Everything else -------------------------------------------------------

test('an undeclared collection is closed to everyone', async () => {
  await reset();
  await establishedCompany();
  const db = await asAdmin();
  await assertFails(setDoc(doc(db, 'secrets', 'x'), { a: 1 }));
  await assertFails(getDocs(collection(db, 'secrets')));
});

test('a signed-out visitor can do nothing at all', async () => {
  await reset();
  await establishedCompany();
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDocs(collection(db, 'shifts')));
  await assertFails(getDoc(doc(db, 'jobSites', SITE.id)));
  await assertFails(setDoc(doc(collection(db, 'shifts')), shiftDoc('bob')));
});

test.after(async () => {
  await testEnv.cleanup();
});
