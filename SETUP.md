# Setup

Start to finish in about fifteen minutes. You need a Google account and a
credit card on file for Firebase — Cloud Functions requires the pay-as-you-go
**Blaze** plan. For a crew of any normal size this stays inside the free
allowance; you are giving them a card, not a budget.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**.
2. Name it (for example `acme-clock-in`) and finish the wizard. Google
   Analytics is not used by this app — turn it off if you like.
3. In the left sidebar, open the **⚙ Settings → Usage and billing → Details &
   settings** and switch the plan to **Blaze**.

## 2. Turn on the services

In the Firebase console:

**Authentication** → Get started → **Email/Password** → Enable → Save.

> Leave "Email link (passwordless sign-in)" off.
>
> You may also want **Authentication → Settings → User actions** and untick
> "Enable create (sign-up)" once you have your first admin account. It is not
> required — someone who signs themselves up has no employee profile and can do
> nothing at all — but turning it off keeps your user list tidy.

**Firestore Database** → Create database → **Production mode** → pick a
location close to your crew. The rules in this repo replace the defaults.

**Storage** → Get started → **Production mode** → same location.

## 3. Register the web app

**⚙ Project settings → General → Your apps → Web (`</>`)**.

Give it a nickname, tick **Also set up Firebase Hosting**, and register. Copy
the `firebaseConfig` values off the next screen — you need them in step 5.

## 4. Get the code onto your machine

```bash
git clone <this repository>
cd Clock-in

npm install -g firebase-tools
firebase login

cp .firebaserc.example .firebaserc
# edit .firebaserc and replace your-firebase-project-id with your real project id

npm --prefix functions install
npm --prefix web install
```

## 5. Fill in the web config

```bash
cp web/.env.example web/.env
```

Open `web/.env` and paste in the values from step 3:

```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=acme-clock-in.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=acme-clock-in
VITE_FIREBASE_STORAGE_BUCKET=acme-clock-in.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
VITE_FIREBASE_APP_ID=1:1234567890:web:abc123
VITE_FUNCTIONS_REGION=us-central1
VITE_USE_EMULATORS=false
```

> Copy `VITE_FIREBASE_STORAGE_BUCKET` exactly as the console shows it. Newer
> projects use `.firebasestorage.app`; older ones use `.appspot.com`. Getting
> this wrong breaks photo uploads and nothing else, which is a confusing way to
> find out.

These values are not secrets — a Firebase web config is designed to ship in the
browser bundle. Access is controlled by the security rules and Cloud Functions
in this repo, not by hiding these strings.

## 6. Deploy

```bash
npm --prefix functions run build
npm --prefix web run build
firebase deploy
```

That pushes the functions, the security rules, the Firestore indexes and the
website. It takes a few minutes the first time; the indexes may show as
"Building" for a little longer, which is fine.

Your site is live at `https://<project-id>.web.app`.

## 7. Make yourself the administrator

The app has no sign-up page — administrators create every account. So the first
admin is created by hand, once:

1. Firebase console → **Authentication → Users → Add user**. Enter your email
   and a password.
2. Open your site and sign in with them.
3. You will land on a **Set up your company** screen. Enter your name and tap
   **Make me the administrator**.

That is a one-time door: the function behind it refuses to run once any
administrator exists, so it cannot be used to escalate later.

Now add your first job site (**Job sites → + Add site**) and your first worker
(**Workers → + Add employee**). Each new worker gets a one-time password shown
to you **once** — write it down or copy it before closing the dialog. Nothing
is emailed; you hand it over however you normally do.

---

## 8. Recommended: turn on App Check

App Check attests that API calls come from your real app in a real browser. It
is the difference between "a worker would have to spoof GPS on their phone" and
"a worker could write a script." Strongly worth the ten minutes.

1. Firebase console → **App Check → Apps → your web app → reCAPTCHA
   Enterprise → Register**. Follow the link to create a key for your site's
   domain and paste the site key back in.
2. Add the key to `web/.env`:
   ```
   VITE_RECAPTCHA_SITE_KEY=6Lc...
   ```
3. Rebuild and deploy the site **first**, so browsers start sending App Check
   tokens:
   ```bash
   npm --prefix web run build && firebase deploy --only hosting
   ```
4. Then turn on enforcement in the backend. Create `functions/.env` — the
   Firebase CLI uploads this on deploy, unlike `functions/.env.local` which is
   only ever read by the emulator:
   ```
   ENFORCE_APP_CHECK=true
   ```
   ```bash
   npm --prefix functions run build && firebase deploy --only functions
   ```

Order matters. Enforcing before the web app is sending tokens locks everyone
out until you deploy hosting.

## 9. Optional: your own domain

**Hosting → Add custom domain** and follow the DNS instructions. Firebase
provisions the HTTPS certificate for you.

HTTPS is not optional here — browsers refuse to give location to a page served
over plain HTTP, so the app would fall back to photos for everyone.

---

## Day-to-day operations

**Someone forgot their password.** Workers → their row → **Reset password**.
Their old password stops working immediately and you get a new one-time
password to hand over.

**Someone left.** Workers → **Deactivate**. They are signed out within seconds
and cannot clock in. Their history stays intact for payroll.

**A worker's punch is stuck in review.** Review tab. You get both punches, the
coordinates with a map link, the photo, distance, accuracy, device and IP.
Approve or reject with a note — the worker sees a rejection note on their
timesheet.

**Someone forgot to clock out.** A nightly sweep closes any shift open longer
than 16 hours, records it as zero minutes, and puts it in the review queue.
Fix the times with **Timesheets → Adjust times**; a reason is required and the
edit is recorded in the audit log against your name.

**Payroll.** Timesheets → set the dates → **Export CSV**.

## Tuning

Every threshold lives in `functions/src/config.ts` with a comment explaining
the number. The ones you are most likely to touch:

| Setting | Default | When to change it |
|---|---|---|
| `defaultSiteRadiusMeters` | 150 m | Per-site radius is set in the UI; this is just the starting value. |
| `maxAccuracyMeters` | 150 m | Raise if crews work somewhere with chronically poor GPS and hit the photo path too often. |
| `maxShiftHours` | 16 h | Set above your longest realistic shift. |
| `minSecondsBetweenActions` | 30 s | Rarely worth changing. |

After editing, `npm --prefix functions run build && firebase deploy --only functions`.
If you change a threshold that the clock screen displays as a hint, mirror it in
`web/src/lib/policy.ts` too — the server value is the one that decides, but the
hint text should not contradict it.

## Troubleshooting

**"Not configured yet" on a blank page.** `web/.env` is missing or incomplete.
Fill it in and rebuild — Vite bakes these in at build time, so a redeploy is
required after any change.

**Everyone is sent to the photo fallback.** Check the site is being served over
HTTPS, and that the site's coordinates are right (Job sites → **View on map**).
A radius set too tight is the other common cause.

**Photo uploads fail.** Almost always `VITE_FIREBASE_STORAGE_BUCKET` not
matching the console exactly. Check the Storage rules deployed:
`firebase deploy --only storage`.

**"The query requires an index."** The indexes are in `firestore.indexes.json`;
deploy them with `firebase deploy --only firestore:indexes` and give it a
minute or two to build.

**A callable returns "unauthenticated" straight after creating a worker.**
Their ID token has not picked up the new custom claims yet. Signing out and back
in fixes it; the app also refreshes the token automatically when it notices the
mismatch.
