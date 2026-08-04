# Setup

Two parts: about five minutes of clicking in the Firebase console, then one
command that does the rest.

## What it costs

Cloud Functions requires the pay-as-you-go **Blaze** plan, and on any project
created recently Cloud Storage does too. So yes — you need a card on the
account before this will deploy.

That is a billing account, not a bill. A crew of a few dozen clocking in and
out twice a day sits inside the free monthly allowance with room to spare; the
free tier covers 2M function calls, 5 GB of stored files and 50k Firestore
reads a day. The photos are the only thing that accumulates, and they are
resized to about 150 KB before upload. Set a budget alert at step 2 if you want
a hard backstop.

---

## Part 1 — the Firebase console

### 1. Create the project

<https://console.firebase.google.com> → **Add project**. Name it something like
`coburn-clock-in`. Google Analytics is not used here; turn it off if you like.

Note the **project ID** off the settings page — it is the lowercase one,
possibly with a number on the end, not the display name. You will need it.

### 2. Upgrade to Blaze

**⚙ Settings → Usage and billing → Details & settings → Modify plan → Blaze.**

While you are there, set a budget alert (say $10/month) so you hear about it
long before anything surprising happens.

### 3. Turn on Authentication

**Build → Authentication → Get started → Email/Password → Enable → Save.**

Leave "Email link (passwordless sign-in)" off.

### 4. Create the database

**Build → Firestore Database → Create database → Production mode**, then pick a
region close to your crew (`us-west1` for Chino). The rules in this repo replace
the defaults on deploy.

> The region is permanent. Storage should match it in the next step.

### 5. Turn on Storage

**Build → Storage → Get started → Production mode →** same region as Firestore.

This is where the proof-of-presence photos go. It needs Blaze from step 2.

---

## Part 2 — deploy

### From a computer

```bash
git clone <this repository>
cd Clock-in
./deploy.sh
```

It asks for your project ID, then handles the rest: reads your web app config
straight out of the project (no copy-pasting six values), writes `web/.env`,
installs, builds, and deploys the rules, indexes, functions and website.

Safe to re-run as many times as you like — nothing it does is destructive, and
anything already deployed is skipped.

If a step fails it tells you exactly which console page fixes it. The two you
are most likely to hit on a fresh project:

- **Storage deploy failed** — step 5 above was skipped, or Blaze is not active.
- **Functions deploy failed** — Blaze is not active, or Google wants you to
  enable an API first. The error names it and prints the link. Enable it, wait a
  minute, re-run. If only the nightly auto-close fails, the script deploys
  everything else anyway and tells you — the app works fine without it.

When it finishes you get a URL: `https://<project-id>.web.app`.

### From your phone

You do not need a laptop. **Google Cloud Shell** is a real Linux terminal in a
browser tab, already signed in to your Google account, with the Firebase CLI
preinstalled.

**[Tap here to start →](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Fmad1661%2FClock-in.git&cloudshell_workspace=.&cloudshell_tutorial=TUTORIAL.md)**

That link clones the repo and opens `TUTORIAL.md` as a step-by-step pane beside
the terminal, with a copy button on every command — you should not have to type
anything except your project ID.

You will be asked to authorise GitHub once, because the repository is private.

If the link does not open the walkthrough, do it by hand instead:

```bash
git clone https://github.com/mad1661/Clock-in.git
cd Clock-in
./deploy.sh
```

When it asks you to sign in to Firebase it prints a link and a code: tap the
link, choose your Google account, copy the code back, paste it into the
terminal. The script detects Cloud Shell and uses that flow automatically,
because the normal one waits on a localhost callback a phone cannot provide.

Turn your phone sideways — the terminal is far easier in landscape.

### Later deploys, from anywhere

```bash
./deploy.sh                 # everything
./deploy.sh --hosting-only  # just the website, when that is all you changed
```

### Optional: deploy by tapping a button

`.github/workflows/deploy.yml` lets you deploy from the GitHub mobile app —
**Actions → Deploy → Run workflow**. Worth wiring up once you are making regular
changes. It is fiddlier to set up than Cloud Shell and easier from a computer,
because it involves handling a key file:

1. Firebase console → **⚙ Project settings → Service accounts → Generate new
   private key**. A `.json` file downloads.
2. That key can only talk to the Admin SDK by default; it needs deploy rights.
   Go to <https://console.cloud.google.com/iam-admin/iam>, find the
   `firebase-adminsdk-…` account, edit it, and add these roles:
   **Firebase Admin**, **Cloud Functions Admin**, **Service Account User**,
   **Cloud Build Editor**, **Artifact Registry Administrator**.
3. In GitHub → **Settings → Secrets and variables → Actions**:
   - **New repository secret** named `FIREBASE_SERVICE_ACCOUNT` — paste the
     entire contents of the JSON file, braces included.
   - **Variables** tab → **New repository variable** named
     `FIREBASE_PROJECT_ID` — your project id.

> That key is a password to your Firebase project. Do not commit it, do not
> email it to yourself, and delete the downloaded file once it is pasted in.
> If it ever leaks, revoke it under Service accounts → Manage keys.

If you already have a computer handy, `firebase init hosting:github` sets all of
this up for you, correctly scoped, in one command.

---

## Part 3 — make yourself the administrator

The app has no sign-up page; administrators create every account. So the first
one is made by hand, once:

1. **Authentication → Users → Add user.** Your email and a password.
2. Open `https://<project-id>.web.app` and sign in with it.
3. You land on a **Set up your company** screen. Enter your name and tap
   **Make me the administrator**.

That door closes behind you: the function refuses to run once any administrator
exists, so it cannot be used to escalate later.

Then add your first job site (**Job sites → + Add site** — stand at the middle
of the site and tap "Use my current location") and your crew
(**Workers → + Add employee**). Each new worker gets a one-time password shown
to you **once** — copy it before closing the dialog. Nothing is emailed; you
hand it over however you normally would.

---

## Recommended: turn on App Check

App Check attests that API calls come from your real app in a real browser. It
is the difference between "a worker would have to spoof GPS on their phone" and
"a worker could write a script." Worth the ten minutes once the app is running.

1. **App Check → Apps → your web app → reCAPTCHA Enterprise → Register.**
   Follow the link to create a key for your domain, paste the site key back in.
2. Add it to `web/.env`:
   ```
   VITE_RECAPTCHA_SITE_KEY=6Lc...
   ```
3. Deploy the website **first**, so browsers start sending tokens:
   ```bash
   ./deploy.sh --hosting-only
   ```
4. Then turn on enforcement. Create `functions/.env`:
   ```
   ENFORCE_APP_CHECK=true
   ```
   and deploy:
   ```bash
   ./deploy.sh
   ```

Order matters — enforcing before the web app sends tokens locks everyone out
until you deploy hosting.

> `functions/.env` is uploaded on deploy. `functions/.env.local` is the
> emulator-only one and never leaves your machine.

## Optional: your own domain

**Hosting → Add custom domain**, follow the DNS instructions. Firebase
provisions the HTTPS certificate.

HTTPS is not optional here — browsers refuse to give location to a page served
over plain HTTP, so everyone would land on the photo fallback.

---

## Day-to-day

**Someone forgot their password.** Workers → their row → **Reset password**.
The old one stops working immediately and you get a new one-time password to
hand over.

**Someone left.** Workers → **Deactivate**. They are signed out within seconds
and cannot clock in. Their history stays intact for payroll.

**A punch is stuck in review.** Review tab, "Needs review". You get both
punches, coordinates with a map link, the photo, distance, accuracy, the handset
and the IP. Approve or reject with a note — a rejection note shows on the
worker's timesheet.

**A worker asked to correct their hours.** Review tab, "Change requests". You
see the recorded times beside what they are asking for, their reason, and the
captured evidence underneath. Approving applies the change and marks the shift
worker-edited; turning it down needs a note, which they see. Nothing moves until
you decide. Workers can request corrections on their own closed shifts for 14
days; after that it is a supervisor adjustment.

**Two workers clocked in from the same phone.** That trips the shared-handset
flag into the review queue. Check the device handle (`D-4F2A9C`) on each punch —
model names are often identical, so the handle is what tells them apart. Not
always dishonest: a crew lead clocking in someone whose battery died looks the
same.

**Someone forgot to clock out.** The nightly sweep closes any shift open longer
than 16 hours, records it as zero minutes, and queues it for review. Fix it with
**Timesheets → Adjust times**; a reason is required and the edit is audited
against your name.

**Who is on site right now?** The **On site** tab. Live — a clock-in shows up
within a second — grouped by job site, with a running timer per worker and a
warning on anyone past ten hours who has probably forgotten to clock out.

**Payroll.** Timesheets → set the dates → **Export CSV**. The export includes a
California overtime summary per worker (regular / 1.5x / 2x), worked out week by
week using the daily rules — four ten-hour days is 8 hours of overtime even
though the week totals 40. Treat it as a cross-check against whoever runs your
payroll, not as a payroll calculation: it does not know about alternative
workweek agreements, exempt staff, or meal-period premiums.

**A punch is flagged "Saved offline, synced later".** The worker was somewhere
with no signal. The app held the punch on their phone and sent it in when the
connection came back, so its time came from the phone rather than the server.
That is why it needs your sign-off. Anything over 24 hours old is refused
outright and has to be added by hand.

**Tell the crew to install it.** On the site, tap Share → Add to Home Screen
(iPhone) or the install prompt (Android). It then opens like an app, and opens
even with no connection.

## Tuning

Every threshold lives in `functions/src/config.ts`, each with a comment
explaining the number. The ones most worth touching:

| Setting | Default | When to change it |
|---|---|---|
| `defaultSiteRadiusMeters` | 150 m | Per-site radius is set in the UI; this is only the starting value. |
| `maxAccuracyMeters` | 150 m | Raise if a site has chronically poor GPS and honest crews keep hitting the photo path. |
| `maxShiftHours` | 16 h | Set above your longest realistic shift. |
| `maxEditRequestAgeDays` | 14 d | How far back a worker may ask to correct their own timesheet. Keep it inside your payroll period. |
| `sharedDeviceWindowHours` | 12 h | How long after one worker punches on a handset another trips the shared-device flag. |
| `minSecondsBetweenActions` | 30 s | Rarely worth changing. |

Then `./deploy.sh`. If you change a threshold the clock screen displays as a
hint, mirror it in `web/src/lib/policy.ts` too — the server value decides, but
the hint should not contradict it.

## Troubleshooting

**"Not configured yet" on a blank page.** `web/.env` is missing or incomplete.
Re-run `./deploy.sh`, which regenerates it. Vite bakes these values in at build
time, so a rebuild and redeploy is always required after changing them.

**Everyone is pushed to the photo fallback.** Check the site is served over
HTTPS, and that the site coordinates are right (Job sites → **View on map**). A
radius set too tight is the other common cause.

**Photo uploads fail.** Storage was not set up (Part 1 step 5), or the region
does not match. Check `VITE_FIREBASE_STORAGE_BUCKET` in `web/.env` against
**Storage** in the console.

**"The query requires an index."** `./deploy.sh` pushes them; they take a minute
or two to build. Progress is under **Firestore → Indexes**.

**A callable returns "unauthenticated" right after creating a worker.** Their ID
token has not picked up the new custom claims yet. Signing out and back in fixes
it; the app also refreshes the token automatically once it notices.

**Deploy says the Node runtime is not supported.** Update the CLI:
`npm install -g firebase-tools`.
