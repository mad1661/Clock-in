# Setting up the time clock

Everything here runs on the **free Spark plan**. You do not need a billing
account, the Blaze plan, or Cloud Build.

The project is already created and pinned in `.firebaserc`
(`clockit-bc990`), so if you are deploying that project you can skip to step 3.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**.
2. Give it a name. Google Analytics is not used — turn it off.
3. Note the **project ID** (not the display name). You need it below.

## 2. Turn on the two things it uses

**Firestore**

<https://console.firebase.google.com/project/YOUR_PROJECT/firestore>
→ **Create database** → **Production mode** → pick a region close to you.

Production mode is right: the rules in this repo replace the default ones on
your first deploy, and they deny everything the app does not explicitly need.

**Email sign-in**

<https://console.firebase.google.com/project/YOUR_PROJECT/authentication/providers>
→ **Email/Password** → **Enable** → **Save**.

That is all. No Storage, no Functions, no plan upgrade.

## 3. Deploy

```bash
./deploy.sh
```

It signs you in if needed, reads your web app config out of the project, writes
`web/.env`, builds the site, and deploys the rules and the website. Re-run it
any time.

If you would rather run the commands yourself:

```bash
npm --prefix web install
npm --prefix web run build
firebase deploy --only hosting,firestore --project YOUR_PROJECT
```

`--only hosting,firestore` is the whole deploy. There is deliberately nothing
else — no functions target exists in `firebase.json`, so a plain
`firebase deploy` will not try to build one.

## 4. Make yourself the administrator

1. Create your own login:
   <https://console.firebase.google.com/project/YOUR_PROJECT/authentication/users>
   → **Add user** → your email address and a password.
2. Open `https://YOUR_PROJECT.web.app` and sign in with it.
3. You will land on **Set up your company**. Enter your name and tap
   **Make me the administrator**.

That works exactly once. The security rules allow an admin profile to be created
only alongside the company record, and the company record can only be created
once — so the first person through this screen claims it, and nobody after can.

If you see *"Could not continue"* on that screen, the company has already been
claimed. Ask whoever set it up to create an account for you under **Workers**.

## 5. Add a job site and your crew

Signed in as an administrator you land on **Home**, which lists whatever is still
missing — crew, a job site, equipment — with a link to each. Work down it and the
list disappears. After that Home shows who is on site, anything waiting on your
approval, and today's tickets.

**Job sites** → **+ Add site**. Search an address, tap the map, or stand on site
and tap *use my current location*. Set the boundary radius — 100 m is a sensible
default for a yard; make it big enough to cover where people actually park and
walk in.

**Workers** → **+ Add employee**. A one-time password is generated and shown
**once**. Copy it and give it to them; they change it on first sign-in under
**Account**. If you lose it, use **Send reset link**. Set their hourly wage here
too — it drives the labour total on the timesheet and never appears on anything
a customer sees.

## 6. Owner and supervisors

Whoever claimed the company is its **owner**, shown with an Owner badge under
Workers. Supervisors run the yard; the owner decides who the supervisors are.

**Make owner** appears next to any active supervisor, and only the owner sees
it. It is a transfer — you stay a supervisor, they become the owner, and only
they can hand it back. The owner cannot be deactivated or demoted by anyone, so
there is no way to end up with a company nobody owns.

**Activity** lists every change anyone has made, newest first, searchable and
exportable as CSV. Changes to somebody's hours show what the times were before
and after. Nothing in that list can be edited or deleted by anybody.

## 7. Equipment and the rental ticket

**Equipment** → **+ Add machine**. Type and machine number exactly as they
should print — `D8T`, `2`. Add the rental rate per hour while you are there.

Machines get assigned in two places, and both are optional:

- **On the job site** — tick the machines that are on that job. Change it at any
  point, before the job starts or after it has finished.
- **On the employee** — tick the machines an operator usually runs. Theirs is
  then already selected when they clock in, so most people never touch the
  picker.

Neither list restricts anyone. An operator is always offered the machines on the
job *and* their own, so somebody who climbs into a machine nobody assigned can
still say so — and the ticket is built from what they actually picked, never
from the assignment lists.

They are asked for the hour meter when they clock out.

**Rental ticket** → pick the site and the day. The table fills itself in from the
clock. Type in any hour-meter readings and downtime, **Save** to fix the ticket
number, then **Print / PDF**.

One operator is one line. Clocking out for lunch and back in fills the form's
second pair of in/out columns on that same line — the afternoon's finish time
appears once they clock out. Anyone still on the clock is shown with a blank
finish and their hours marked `*`, so nobody is missing from the customer's copy
just because they forgot to clock out. **Rebuild from timesheet** picks up
anything that has changed since.

**Signing.** Tap the signature line at the bottom of the sheet (or **Sign off**)
and sign with a finger or a stylus. Your name and the time are recorded with it,
and it prints on the ticket. Editing the sheet afterwards clears the signature
and asks you to sign again — it stands for the figures that were on it at the
time. **Clear signature** takes it off entirely.

Save yourself the redrawing: **Account → My signature**, sign once, and every
ticket after that is one tap on *Use my saved signature*.

To carry on from your paper ticket book, set the next number once — it is stored
on the company record and each new ticket takes the next one.

---

## Optional: App Check

App Check makes it harder to talk to your database with anything other than the
real app. It is optional and the app runs fine without it.

1. Register a **reCAPTCHA v3** site key at
   <https://www.google.com/recaptcha/admin> (v3 is free; do **not** pick
   Enterprise, which needs billing).
2. <https://console.firebase.google.com/project/YOUR_PROJECT/appcheck> → register
   your web app with that key.
3. Put the site key in `web/.env` as `VITE_RECAPTCHA_SITE_KEY=…` and redeploy.

Turn on enforcement for Firestore only after you have confirmed the app still
works with the key in place.

## Optional: maps

Maps use Esri's public World Imagery basemap with no key, which is fine to get
going. An ArcGIS location platform key (free tier at developers.arcgis.com) in
`VITE_ARCGIS_API_KEY` switches to the supported production basemaps.

---

## Running it locally

```bash
npm --prefix web install
npm run emulators          # Auth, Firestore and Hosting on your machine
```

Point the web app at them by setting `VITE_USE_EMULATORS=true` in `web/.env`,
then `npm --prefix web run dev`.

Tests:

```bash
npm test                   # the security rules — the important one
npm run test:ui            # end-to-end browser test (emulators must be running)
npm run test:overtime      # California overtime maths
```

---

## Troubleshooting

**"Missing or insufficient permissions"** — the rules are not deployed. Run
`firebase deploy --only firestore`.

**"Could not continue" on the setup screen** — the company is already claimed.
See step 4.

**"API key not valid" / nobody can sign in** — the site was built with a Firebase
API key the project no longer recognises, usually because the browser key was
deleted or regenerated. Note that the **browser API key** (Google Cloud console →
APIs & Services → Credentials, named *Browser key (auto created by Firebase)*)
is a different thing from a **service account key** (Firebase console → Project
settings → Service accounts); deleting the wrong one causes exactly this.

**Redeploying does not fix this on its own.** `firebase apps:sdkconfig` reports
the key recorded against the Firebase *web app registration*, and that record
keeps handing back the same key string long after the key itself has been
deleted — so the build faithfully bakes in a key that no longer exists.

Check which key you have and whether it is alive:

```bash
grep VITE_FIREBASE_API_KEY web/.env
curl -s "https://identitytoolkit.googleapis.com/v1/recaptchaParams?key=$(grep '^VITE_FIREBASE_API_KEY=' web/.env | cut -d= -f2-)"
```

`API_KEY_INVALID` in that output means the key is gone. Get a working one from
<https://console.cloud.google.com/apis/credentials> — restore the deleted key if
the console offers it (Google keeps them for 30 days), otherwise **Create
credentials → API key** — then deploy with it explicitly:

```bash
./deploy.sh --api-key AIza…
```

`deploy.sh` now makes this same check before it builds, so it refuses to ship a
site nobody can sign in to.

**A worker cannot clock in at a site** — check the site is **active**, and that
they are either unassigned (which means all sites) or assigned to that one.

**Punches keep landing in the review queue** — the boundary is probably too
tight for where people actually stand. Open the site on the map and check the
circle covers the whole working area, not just the office trailer.

**Someone left without clocking out** — **On site** → close the shift. It is
flagged so it is obvious on the timesheet.

**A deactivated worker can still sign in** — expected, and harmless. Disabling
the Auth account itself needs the Admin SDK. Every rule checks `active`, so they
can read nothing and write nothing; they see an "account deactivated" screen.
