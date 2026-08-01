# Clock In

A Firebase web app for clocking crews in and out of job sites, with location
verification and a photo fallback when location services are not available.

Built for a phone in daylight on a building site: one enormous button, no
hover-only controls, and nothing important below the fold.

**New here? Go to [SETUP.md](SETUP.md)** — it walks through creating the
Firebase project and deploying, start to finish, in about fifteen minutes.

---

## What it does

**For workers**

- Sign in with an email and password their administrator gives them.
- Pick a job site and tap one button to clock in or out.
- The app takes a GPS fix and confirms they are inside the site's boundary.
- If it cannot — permission off, no signal, or genuinely off site — the app
  explains why, offers to retry, and otherwise asks for a photo taken at the
  job site. **The punch is still recorded**; it goes to the administrator for
  approval rather than being lost.
- A live timer while on shift, and their own timesheet.

**For administrators**

- Create worker logins. A one-time password is generated and shown once.
- Reset passwords, deactivate people, promote to administrator.
- Define job sites: name, address, coordinates and a boundary radius, with a
  "use my current location" button for setting it while standing on site.
- Assign workers to specific sites, or leave them free to use any site.
- A review queue of everything the app could not verify automatically, with the
  full evidence: both punches, coordinates, a map link, the photo, distance,
  accuracy, device and IP.
- Timesheets with date and worker filters, totals, and CSV export for payroll.
- Adjust shift times when something goes wrong, with a mandatory reason.

---

## How the verification works

The design goal is that a worker cannot clock in from their sofa, and that an
honest worker on site is never left unable to record their hours. Those pull in
opposite directions, so the app layers checks rather than relying on one.

### Nothing is decided by the client

The browser never writes to the database. Firestore and Storage rules deny all
client writes outright; every mutation goes through a Cloud Function running
with the Admin SDK. The client reports what its GPS said — the server decides
what that is worth.

That means patching the JavaScript, replaying an ID token from a script, or
calling the API by hand gets you no further than the normal app does.

### What the server checks on every punch

| Check | Why |
|---|---|
| Fix accuracy ≤ 150 m | A phone outdoors reports 5–30 m. IP-based geolocation on a laptop reports kilometres. |
| Fix age ≤ 2 minutes | Stops a fix captured on site this morning being replayed from home tonight. |
| Distance ≤ site radius + accuracy slack (capped at 75 m) | Honest workers get the benefit of their fix's error bars; nobody can claim a 10 km accuracy radius to "reach" a site. |
| Timestamp | Always the server's clock. A device with a wrong clock is flagged, never trusted. |
| Impossible travel | Two punches 160 km apart twenty minutes apart get flagged. |
| Already clocked in? | One open shift per person, created with `create()` so a double-tap loses cleanly. |
| Rate limit | 30 seconds between actions. |
| Site assignment | A worker restricted to certain sites cannot punch at others. |
| Account still active | Re-read from Firestore on every call, because a custom claim in an ID token can be up to an hour stale. |

### The photo fallback

When the GPS evidence is not good enough, the server refuses the punch with a
structured `PHOTO_REQUIRED` response, and the app switches to the photo path.
It first shows device-specific instructions for turning location back on —
that is quicker for everyone — and offers a retry. If location genuinely will
not work, the worker takes a photo and the punch is recorded, flagged, and
queued for approval.

The photo is checked server-side against the object in Cloud Storage, not
against anything the client claims:

- **It is in the caller's own prefix.** You cannot point at someone else's photo.
- **It exists, is an image, and is under 8 MB.**
- **Storage's own `timeCreated` is seconds old.** A photo pulled out of the
  camera roll is rejected. The client also sets `capture="environment"` to open
  the camera rather than the gallery, and warns on a stale `lastModified` — but
  those are hints, and the server check is the one that binds.
- **It has never backed another punch.** A create-only claim document burns the
  path, so one photo cannot cover both a clock-in and a clock-out.

Photos are write-once: Storage rules deny overwrite and delete, so once a photo
is evidence it stays as it was.

### Everything ends up in front of a human

Anything unverified is flagged, never silently accepted and never silently
dropped. The administrator sees the reason and the raw evidence and decides.
Approvals, rejections and manual time edits all land in an append-only audit
log that no client can read or write.

### Honest limits

Worth knowing before you rely on this:

- **Browser geolocation cannot prove a device is not spoofing.** A rooted phone
  with a mock-location app can lie to any web app. The defence is the layering:
  the fix has to be accurate, fresh, inside the fence, and consistent with the
  previous punch — and everything else gets a human's eyes. Turn on App Check
  (see SETUP.md) to close the scripted-client route.
- **A photo proves a camera was pointed at something, not who was holding it.**
  It is evidence for a supervisor who knows the site, not automated proof.
- **Indoors, GPS is poor.** Basements and steel-framed buildings will push
  people onto the photo path. Set site radii generously — 150 m is a sensible
  default; a 25 m fence will generate constant false failures.

---

## Project layout

```
firestore.rules          Read-only for clients, scoped to their own data
storage.rules            Write-once photo uploads, admin-only reads
firebase.json            Hosting, rules, functions and emulator config

functions/src/
  clock.ts               Clock in/out — the verification logic
  photo.ts               Server-side photo checks and single-use claims
  geo.ts                 Haversine distance, input validation
  adminUsers.ts          Worker accounts, roles, passwords, bootstrap
  jobSites.ts            Job site management
  review.ts              Approvals, time adjustments, nightly sweep
  config.ts              Every tunable threshold, in one place

web/src/
  pages/ClockPage.tsx    The clock screen and photo fallback
  pages/admin/           Workers, job sites, timesheets, review queue
  lib/geolocation.ts     Best-fix acquisition, failure classification
  lib/photo.ts           Capture, downscale, upload
  auth/AuthProvider.tsx  Session, live profile, claim refresh
```

## Data model

- `users/{uid}` — profile, role, active flag, assigned sites.
- `jobSites/{id}` — name, address, coordinates, radius, active flag.
- `shifts/{id}` — one document per shift, holding both punch records with their
  full evidence, plus flags and review state.
- `auditLogs/{id}` — append-only trail of every administrative action.
- `photoClaims/{hash}` — burnt photo paths; unreadable by any client.

## Development

```bash
npm --prefix functions install
npm --prefix web install
cp web/.env.example web/.env      # then fill it in

# Terminal 1 — emulators (needs Java 11+)
npm --prefix functions run build
firebase emulators:start --project demo-clockin

# Terminal 2 — the app
npm --prefix web run dev          # with VITE_USE_EMULATORS=true in web/.env
```

### Tests

Both suites run against a **freshly started** emulator suite — the emulators
hold their data in memory, and both tests seed their own.

```bash
npm --prefix web run test:api     # 63 checks: server logic and security rules
npm --prefix web run test:ui      # 26 checks: browser flows via Playwright
```

`test:api` covers the verification thresholds, the photo anti-replay checks,
privilege escalation attempts, and the security rules. `test:ui` drives a real
Chromium with mocked geolocation through the on-site, off-site and
permission-denied paths, plus the admin console.

`test:ui` reads the built app from the hosting emulator on port 5000, so run
`npm --prefix web run build` first. Set `SCREENSHOT_DIR` to capture screenshots.
