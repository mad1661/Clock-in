/**
 * End-to-end smoke test against the Firebase emulator suite.
 *
 * Exercises the paths that matter for correctness: bootstrap, worker creation,
 * a clean GPS clock-in, the photo fallback, the anti-replay checks, admin
 * review, deactivation, and the security rules that keep clients out of the
 * data.
 *
 * Run with the emulators up:
 *   firebase emulators:start --project demo-clockin
 *   node web/e2e-smoke.mjs
 */
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  getDocs,
  collection,
  query,
  where,
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getStorage, connectStorageEmulator, ref, uploadBytes } from 'firebase/storage';

const PROJECT = 'demo-clockin';
const SITE = { lat: 51.5074, lng: -0.1278, radiusMeters: 150 };

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function newClient(name) {
  const app = initializeApp(
    { apiKey: 'demo', projectId: PROJECT, appId: '1:1:web:1', storageBucket: `${PROJECT}.appspot.com` },
    name,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const fns = getFunctions(app, 'us-central1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const storage = getStorage(app);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  return { app, auth, db, fns, storage, call: (n) => httpsCallable(fns, n) };
}

/** Offsets a lat/lng by a distance in metres, due north. */
function north(base, meters) {
  return { lat: base.lat + meters / 111320, lng: base.lng };
}

function locationPayload(point, accuracy = 12) {
  return { ...point, accuracy, capturedAt: Date.now() };
}

const device = { userAgent: 'e2e', platform: 'node', timezone: 'UTC', clientTime: Date.now() };

/** A 1x1 JPEG. Content does not matter; the server checks size, type and age. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

async function uploadTestPhoto(client, uid, suffix = '') {
  const path = `clock-photos/${uid}/${Date.now()}${suffix}-${Math.random().toString(36).slice(2)}.jpg`;
  await uploadBytes(ref(client.storage, path), TINY_JPEG, { contentType: 'image/jpeg' });
  return path;
}

async function expectFailure(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function main() {
  console.log('\n=== 1. Bootstrap the first administrator ===');
  const admin = newClient('admin');
  await createUserWithEmailAndPassword(admin.auth, 'boss@example.com', 'Password123!');
  await admin.call('bootstrapAdmin')({ displayName: 'The Boss' });
  await admin.auth.currentUser.getIdToken(true);
  const claims = (await admin.auth.currentUser.getIdTokenResult()).claims;
  check('admin has role=admin claim', claims.role === 'admin', `got ${claims.role}`);
  check('admin has active=true claim', claims.active === true);

  const secondBootstrap = await expectFailure(admin.call('bootstrapAdmin')({}));
  check('bootstrap refuses to run twice', secondBootstrap !== null, 'second call succeeded!');

  console.log('\n=== 2. Create a job site ===');
  const siteRes = await admin.call('upsertJobSite')({
    name: 'Riverside Tower',
    address: '1 Thames Road',
    lat: SITE.lat,
    lng: SITE.lng,
    radiusMeters: SITE.radiusMeters,
    active: true,
  });
  const siteId = siteRes.data.id;
  check('job site created', Boolean(siteId));

  const badRadius = await expectFailure(
    admin.call('upsertJobSite')({ name: 'Bad', address: '', lat: 0, lng: 0, radiusMeters: 99999 }),
  );
  check('rejects an out-of-range radius', badRadius !== null);

  const badLat = await expectFailure(
    admin.call('upsertJobSite')({ name: 'Bad', address: '', lat: 999, lng: 0, radiusMeters: 100 }),
  );
  check('rejects an invalid latitude', badLat !== null);

  console.log('\n=== 3. Create workers ===');
  const mk = async (email, name) => {
    const res = await admin.call('createWorker')({
      email,
      displayName: name,
      role: 'worker',
      jobSiteIds: [],
    });
    return res.data;
  };
  const sam = await mk('sam@example.com', 'Sam Rivers');
  const ali = await mk('ali@example.com', 'Ali Chen');
  const jo = await mk('jo@example.com', 'Jo Baker');
  const kim = await mk('kim@example.com', 'Kim Patel');
  check('temporary password issued', typeof sam.temporaryPassword === 'string' && sam.temporaryPassword.length >= 12);

  const dupe = await expectFailure(
    admin.call('createWorker')({ email: 'sam@example.com', displayName: 'Clone', role: 'worker', jobSiteIds: [] }),
  );
  check('rejects a duplicate email', dupe !== null);

  console.log('\n=== 4. Worker clocks in on site with a good fix ===');
  const samC = newClient('sam');
  await signInWithEmailAndPassword(samC.auth, sam.email, sam.temporaryPassword);
  const samUid = samC.auth.currentUser.uid;

  const inRes = await samC.call('clockIn')({
    jobSiteId: siteId,
    location: locationPayload(north(SITE, 40)),
    device,
  });
  check('clock-in accepted', inRes.data.method === 'gps', JSON.stringify(inRes.data));
  check('clock-in not flagged', inRes.data.needsReview === false, JSON.stringify(inRes.data.flags));
  check('distance computed', inRes.data.distanceMeters >= 35 && inRes.data.distanceMeters <= 45, `got ${inRes.data.distanceMeters}`);

  const doubleIn = await expectFailure(
    samC.call('clockIn')({ jobSiteId: siteId, location: locationPayload(north(SITE, 40)), device }),
  );
  check('cannot clock in twice', doubleIn !== null);

  console.log('\n=== 5. Location fails → server demands a photo ===');
  const aliC = newClient('ali');
  await signInWithEmailAndPassword(aliC.auth, ali.email, ali.temporaryPassword);
  const aliUid = aliC.auth.currentUser.uid;

  const farAway = await expectFailure(
    aliC.call('clockIn')({ jobSiteId: siteId, location: locationPayload(north(SITE, 5000)), device }),
  );
  check('outside the geofence is refused', farAway !== null);
  check(
    'refusal says PHOTO_REQUIRED',
    farAway?.details?.reason === 'PHOTO_REQUIRED',
    JSON.stringify(farAway?.details),
  );
  check(
    'refusal reports OUTSIDE_GEOFENCE',
    farAway?.details?.flags?.includes('OUTSIDE_GEOFENCE'),
    JSON.stringify(farAway?.details?.flags),
  );

  const noLocation = await expectFailure(
    aliC.call('clockIn')({
      jobSiteId: siteId,
      location: null,
      locationError: { code: 1, message: 'permission-denied' },
      device,
    }),
  );
  check('no location at all is refused', noLocation?.details?.reason === 'PHOTO_REQUIRED');

  const vague = await expectFailure(
    aliC.call('clockIn')({ jobSiteId: siteId, location: locationPayload(SITE, 4000), device }),
  );
  check('a vague fix is refused', vague?.details?.flags?.includes('LOW_ACCURACY'), JSON.stringify(vague?.details?.flags));

  const stale = await expectFailure(
    aliC.call('clockIn')({
      jobSiteId: siteId,
      location: { ...SITE, accuracy: 10, capturedAt: Date.now() - 30 * 60 * 1000 },
      device,
    }),
  );
  check('a replayed old fix is refused', stale?.details?.flags?.includes('STALE_FIX'), JSON.stringify(stale?.details?.flags));

  console.log('\n=== 6. Photo fallback succeeds and is flagged ===');
  const photoPath = await uploadTestPhoto(aliC, aliUid);
  const photoIn = await aliC.call('clockIn')({
    jobSiteId: siteId,
    location: null,
    locationError: { code: 1, message: 'permission-denied' },
    photoPath,
    device,
  });
  check('photo fallback accepted', photoIn.data.method === 'photo', JSON.stringify(photoIn.data));
  check('photo fallback is flagged for review', photoIn.data.needsReview === true);
  check('PHOTO_FALLBACK flag recorded', photoIn.data.flags.includes('PHOTO_FALLBACK'));

  console.log('\n=== 7. Anti-abuse on photos ===');
  const joC = newClient('jo');
  await signInWithEmailAndPassword(joC.auth, jo.email, jo.temporaryPassword);
  const joUid = joC.auth.currentUser.uid;

  const reuse = await expectFailure(
    joC.call('clockIn')({ jobSiteId: siteId, location: null, photoPath, device }),
  );
  check("cannot use another worker's photo", reuse !== null, 'accepted a foreign photo!');

  const joPhoto = await uploadTestPhoto(joC, joUid);
  await joC.call('clockIn')({ jobSiteId: siteId, location: null, photoPath: joPhoto, device });
  const reusedOwn = await expectFailure(
    joC.call('clockOut')({ jobSiteId: siteId, location: null, photoPath: joPhoto, device }),
  );
  check('the same photo cannot back two punches', reusedOwn !== null, 'photo was reused!');

  const missing = await expectFailure(
    joC.call('clockOut')({
      jobSiteId: siteId,
      location: null,
      photoPath: `clock-photos/${joUid}/does-not-exist.jpg`,
      device,
    }),
  );
  check('a non-existent photo is refused', missing !== null);

  console.log('\n=== 8. Security rules keep clients out of the data ===');
  const forgeShift = await expectFailure(
    setDoc(doc(samC.db, 'shifts', 'forged'), { userId: samUid, durationMinutes: 999 }),
  );
  check('worker cannot write a shift', forgeShift !== null, 'client wrote to shifts!');

  const forgeRole = await expectFailure(setDoc(doc(samC.db, 'users', samUid), { role: 'admin' }));
  check('worker cannot promote themselves', forgeRole !== null, 'client wrote to users!');

  const forgeSite = await expectFailure(
    setDoc(doc(samC.db, 'jobSites', siteId), { radiusMeters: 100000 }),
  );
  check('worker cannot widen a geofence', forgeSite !== null, 'client wrote to jobSites!');

  const readOthers = await expectFailure(
    getDocs(query(collection(samC.db, 'shifts'), where('userId', '==', aliUid))),
  );
  check("worker cannot read another worker's shifts", readOthers !== null, 'client read foreign shifts!');

  const readAllShifts = await expectFailure(getDocs(collection(samC.db, 'shifts')));
  check('worker cannot read the whole shifts collection', readAllShifts !== null, 'client read all shifts!');

  const readRoster = await expectFailure(getDocs(collection(samC.db, 'users')));
  check('worker cannot read the employee roster', readRoster !== null, 'client read the roster!');

  const readAudit = await expectFailure(getDocs(collection(samC.db, 'auditLogs')));
  check('worker cannot read the audit log', readAudit !== null);

  const ownShifts = await getDocs(query(collection(samC.db, 'shifts'), where('userId', '==', samUid)));
  check('worker can read their own shifts', ownShifts.size === 1, `got ${ownShifts.size}`);

  console.log('\n=== 9. Admin-only callables reject workers ===');
  const escalate = await expectFailure(
    samC.call('createWorker')({ email: 'x@example.com', displayName: 'X', role: 'admin', jobSiteIds: [] }),
  );
  check('worker cannot create accounts', escalate !== null);

  const siteHijack = await expectFailure(
    samC.call('upsertJobSite')({ name: 'Mine', address: '', lat: 0, lng: 0, radiusMeters: 2000 }),
  );
  check('worker cannot create job sites', siteHijack !== null);

  console.log('\n=== 10. Admin review ===');
  const pending = await getDocs(query(collection(admin.db, 'shifts'), where('needsReview', '==', true)));
  check('flagged shifts are in the review queue', pending.size >= 2, `got ${pending.size}`);

  const openFlagged = pending.docs.find((d) => d.data().status === 'open');
  const reviewOpen = await expectFailure(
    admin.call('reviewShift')({ shiftId: openFlagged.id, decision: 'approved' }),
  );
  check('an open shift cannot be reviewed yet', reviewOpen !== null);

  const rejectNoNote = await expectFailure(
    admin.call('reviewShift')({ shiftId: openFlagged.id, decision: 'rejected' }),
  );
  check('rejection requires a note', rejectNoNote !== null);

  console.log('\n=== 11. Clock out, then review the closed shift ===');
  const outRes = await samC.call('clockOut')({
    jobSiteId: siteId,
    location: locationPayload(north(SITE, 30)),
    device,
  });
  check('clock-out accepted', outRes.data.method === 'gps', JSON.stringify(outRes.data));
  check('duration recorded', typeof outRes.data.durationMinutes === 'number');
  check('clean shift needs no review', outRes.data.needsReview === false);

  const noOpenShift = await expectFailure(
    samC.call('clockOut')({ jobSiteId: siteId, location: locationPayload(SITE), device }),
  );
  check('cannot clock out when not clocked in', noOpenShift !== null);

  const aliOut = await aliC.call('clockOut')({
    jobSiteId: siteId,
    location: locationPayload(north(SITE, 20)),
    device,
  });
  check('flagged shift stays flagged after a clean clock-out', aliOut.data.needsReview === true);

  const aliShift = (await getDocs(query(collection(admin.db, 'shifts'), where('userId', '==', aliUid))))
    .docs[0];
  await admin.call('reviewShift')({
    shiftId: aliShift.id,
    decision: 'approved',
    note: 'Foreman confirmed Ali was on site.',
  });
  const afterReview = (
    await getDocs(query(collection(admin.db, 'shifts'), where('userId', '==', aliUid)))
  ).docs[0].data();
  check('approval clears the review flag', afterReview.needsReview === false);
  check('approval is recorded', afterReview.review.status === 'approved');

  console.log('\n=== 12. Admin time adjustment ===');
  const samShift = (await getDocs(query(collection(admin.db, 'shifts'), where('userId', '==', samUid))))
    .docs[0];
  const noReason = await expectFailure(
    admin.call('adjustShift')({ shiftId: samShift.id, clockOutAt: Date.now(), note: '' }),
  );
  check('adjustment requires a reason', noReason !== null);

  const backwards = await expectFailure(
    admin.call('adjustShift')({
      shiftId: samShift.id,
      clockInAt: Date.now(),
      clockOutAt: Date.now() - 3600_000,
      note: 'nope',
    }),
  );
  check('clock-out cannot precede clock-in', backwards !== null);

  const inAt = samShift.data().clockInAt.toMillis();
  await admin.call('adjustShift')({
    shiftId: samShift.id,
    clockInAt: inAt,
    clockOutAt: inAt + 4 * 3600_000,
    note: 'Phone died; foreman confirmed a four-hour shift.',
  });
  const adjusted = (
    await getDocs(query(collection(admin.db, 'shifts'), where('userId', '==', samUid)))
  ).docs[0].data();
  check('adjusted duration applied', adjusted.durationMinutes === 240, `got ${adjusted.durationMinutes}`);
  check('adjustment is flagged as manual', adjusted.flags.includes('MANUAL_ENTRY'));

  console.log('\n=== 13. Site assignment is enforced ===');
  const otherSite = (
    await admin.call('upsertJobSite')({
      name: 'Depot',
      address: '',
      lat: 52,
      lng: -1,
      radiusMeters: 150,
      active: true,
    })
  ).data.id;
  const kimC = newClient('kim');
  await signInWithEmailAndPassword(kimC.auth, kim.email, kim.temporaryPassword);
  await admin.call('updateWorker')({ uid: kim.uid, jobSiteIds: [otherSite] });
  await kimC.auth.currentUser.getIdToken(true);
  const wrongSite = await expectFailure(
    kimC.call('clockIn')({ jobSiteId: siteId, location: locationPayload(SITE), device }),
  );
  check('cannot clock in at an unassigned site', wrongSite !== null);

  console.log('\n=== 14. Deactivation takes effect immediately ===');
  await admin.call('setWorkerActive')({ uid: sam.uid, active: false });
  const deactivated = await expectFailure(
    samC.call('clockIn')({ jobSiteId: siteId, location: locationPayload(SITE), device }),
  );
  check('a deactivated worker cannot clock in', deactivated !== null, 'deactivated worker clocked in!');

  const selfDeactivate = await expectFailure(
    admin.call('setWorkerActive')({ uid: admin.auth.currentUser.uid, active: false }),
  );
  check('admin cannot deactivate themselves', selfDeactivate !== null);

  const lastAdmin = await expectFailure(
    admin.call('updateWorker')({ uid: admin.auth.currentUser.uid, role: 'worker' }),
  );
  check('the last admin cannot demote themselves', lastAdmin !== null);

  console.log('\n=== 15. Retiring a site ===');
  const busySite = await expectFailure(admin.call('deleteJobSite')({ id: siteId }));
  check('cannot retire a site with someone clocked in', busySite !== null);

  await joC.call('clockOut')({ jobSiteId: siteId, location: locationPayload(north(SITE, 10)), device });
  await admin.call('deleteJobSite')({ id: siteId });
  const retiredSiteIn = await expectFailure(
    aliC.call('clockIn')({ jobSiteId: siteId, location: locationPayload(SITE), device }),
  );
  check('cannot clock in at a retired site', retiredSiteIn !== null);

  console.log('\n=== 16. Audit trail ===');
  const audits = await getDocs(collection(admin.db, 'auditLogs'));
  const actions = new Set(audits.docs.map((d) => d.data().action));
  check('audit log is populated', audits.size > 10, `got ${audits.size}`);
  for (const action of [
    'admin.bootstrap',
    'worker.create',
    'jobsite.upsert',
    'shift.clock_in',
    'shift.clock_out',
    'shift.review',
    'shift.manual_edit',
    'worker.deactivate',
  ]) {
    check(`audit records ${action}`, actions.has(action), [...actions].join(', '));
  }

  await Promise.all(
    [admin, samC, aliC, joC, kimC].map(async (c) => {
      await signOut(c.auth).catch(() => {});
      await deleteApp(c.app);
    }),
  );

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFATAL', err);
  process.exit(1);
});
