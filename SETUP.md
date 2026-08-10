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

**Job sites** → **+ Add site**. Search an address, tap the map, or stand on site
and tap *use my current location*. Set the boundary radius — 100 m is a sensible
default for a yard; make it big enough to cover where people actually park and
walk in.

**Workers** → **+ Add employee**. A one-time password is generated and shown
**once**. Copy it and give it to them; they change it on first sign-in under
**Account**. If you lose it, use **Send reset link**.

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

Fix it by rebuilding with the project's current key:

```bash
./deploy.sh
```

`deploy.sh` reads the config out of the project with `firebase apps:sdkconfig`
and rewrites `web/.env` every time, so it repairs this on its own. Building by
hand does **not** — it uses whatever `web/.env` already says. If the key is
genuinely gone, recreate it in the Google Cloud console under APIs & Services →
Credentials → Create credentials → API key, then run `./deploy.sh`.

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
