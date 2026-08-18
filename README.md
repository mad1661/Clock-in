# Coburn Equipment Rentals — Time Clock

A Firebase web app for clocking crews in and out of job sites, with location
verification and supervisor approval for anything it cannot confirm.

Built for a phone in daylight on a building site: one enormous button, no
hover-only controls, and nothing important below the fold.

**Runs entirely on the free Spark plan.** No Cloud Functions, no Cloud Build, no
Cloud Storage, no billing account. Two things get deployed: the security rules
and the website.

**New here? Go to [SETUP.md](SETUP.md).** Then:

```bash
./deploy.sh
```

or, if you would rather run it yourself:

```bash
npm --prefix web install
npm --prefix web run build
firebase deploy --only hosting,firestore --project clockit-bc990
```

Re-run either any time; nothing they do is destructive. `deploy.sh` additionally
re-reads your Firebase config from the project and checks the API key still
works before building, so it cannot ship a site nobody can sign in to. See
SETUP.md if it ever tells you the key is invalid.

Once deployed, the app lives at **https://clockit-bc990.web.app**.

---

## What it does

**For workers**

- Sign in with an email and password their administrator gives them.
- Pick a job site and tap one button to clock in or out.
- The app takes a GPS fix and confirms they are inside the site's boundary.
- If it cannot — permission off, no signal, or genuinely off site — **the punch
  is still recorded** and sent to a supervisor to approve. Nobody is ever left
  unable to clock in because their phone let them down.
- A live timer while on shift, and their own timesheet.
- Installs to the home screen.
- If something is wrong — forgot to clock out, phone died — they can propose
  corrected times with a reason. **They cannot change their own hours**: the
  request goes to a supervisor and nothing moves until it is approved.

**For administrators**

- A **home screen** that answers the three questions the app gets opened for:
  who is on site, what is waiting for approval, and where today's tickets are.
  On a new company it also lists what still has to be set up.
- Create worker logins. A one-time password is generated and shown once.
- Email password resets, deactivate people, promote to administrator.
- Define job sites on Esri satellite imagery: search an address, tap the map, or
  stand on site and tap "use my current location". The boundary is drawn to
  scale over the actual ground, so you can see the radius covers the pad and not
  the neighbour's yard.
- Assign workers to specific sites, or leave them free to use any site.
- A review queue of everything the app could not verify automatically, with the
  evidence: both punches, coordinates, a map link, distance, accuracy and device.
- Timesheets with date and worker filters, totals, and CSV export for payroll.
- Adjust shift times directly when something goes wrong, with a mandatory reason.
- A separate queue of worker-requested corrections, showing recorded times
  beside the proposed ones. Approve and the times apply; turn it down with a note
  the worker sees on their timesheet.
- See which handset each punch was made on.
- An **Activity** log: every change anyone makes, with who made it and — for
  anything that moved somebody's hours — what it was before and after.
- An **owner**, one level above a supervisor. Only the owner hands ownership on,
  and the owner cannot be switched off or demoted by anybody.
- A live **On site** board: who is clocked in, at which site, for how long —
  with a link straight to that site's ticket for today.
- Keep the yard's **equipment list**, assign machines to a job — before it starts
  or after it has finished — and set each machine's rental rate.
- Assign each operator their usual machine, so it is already chosen when they
  clock in.
- Set each employee's hourly wage; the timesheet totals labour cost from it.
- The **Daily Rental Ticket & Equipment Report**, built from the clock.
- California overtime worked out per week, including the daily rules — four
  ten-hour days is 8 hours of overtime even though the week totals 40.

---

## How the verification works

The design goal is that a worker cannot clock in from their sofa, and that an
honest worker on site is never left unable to record their hours. Those pull in
opposite directions, so the app records everything and flags what it cannot
confirm, rather than refusing.

### The security rules are the server

There are no Cloud Functions. The app writes to Firestore directly, and
[`firestore.rules`](firestore.rules) decides whether each write is allowed.
Google evaluates those rules on their servers, so a patched client, a replayed
ID token or a scripted REST call gets no further than the real app does.

This is the part worth understanding: **the rules do not trust a single number
the client sends.** They recompute the geofence from the job site document,
stamp every timestamp with the server's own clock, and reject anything that
disagrees.

| Check | How the rules enforce it |
|---|---|
| Fix accuracy ≤ 150 m | Read from the punch and compared directly. A phone outdoors reports 5–30 m; IP-based geolocation on a laptop reports kilometres. |
| Fix age ≤ 2 minutes | Compared against `request.time`, so a fix captured on site this morning cannot be replayed from home tonight. |
| Distance ≤ site radius + accuracy slack (capped at 75 m) | Recomputed from the job site document. Honest workers get the benefit of their fix's error bars; nobody can claim a 10 km accuracy radius to "reach" a site. |
| Timestamps | Every stored time must equal `request.time`. A phone with a wrong clock cannot backdate anything. |
| Verified vs flagged | `needsReview` may always be set to `true`, and may only be `false` when the punch genuinely verifies. The client cannot declare its own punch clean. |
| One open shift | A per-worker clock-state document is updated in the same batch as the shift, and the rules require it to name that exact shift afterwards. |
| Rate limit | 30 seconds between punches, measured on the server clock. |
| Account still active | Read from the user document on every single operation. |
| Shift immutability | Once written, a shift can only make the exact transitions below. Deletes are refused for everyone, including administrators. |

Because the geofence is checked twice — optimistically in the browser so the
worker gets an instant answer, then authoritatively in the rules — the two can
disagree at the margins. When they do, the app re-submits the punch flagged for
review rather than failing. **A worker's hours are never lost to a
disagreement.**

### Roles, without custom claims

Custom claims need the Admin SDK, which needs a server. So the role lives in the
worker's user document, which only an administrator can write and which the
rules read directly on every request. A worker cannot promote themselves,
reactivate themselves, or edit anyone else's record — there are tests for each.

The first administrator is bootstrapped with a trick: the rules allow a user
document with `role: 'admin'` to be created **only** in the same batch that
creates `config/company`, and only while that document does not yet exist. Since
it can only be created once, exactly one person can ever claim the company that
way. Everyone after that is created by an administrator.

### When location cannot be confirmed

The punch is recorded, flagged, and queued for approval. Everything that *was*
observed — the best fix, the reported error, the distance, the device — is kept.

This is the deliberate choice. Refusing would mean a worker whose GPS dies
cannot clock in at all, and losing real hours is a worse failure than an entry a
supervisor confirms.

### Corrections go through a supervisor

Workers can ask for their times to be fixed; they cannot fix them. A request
holds the proposed times and the worker's reason on the shift, and changes
nothing until a supervisor rules on it. The rules permit a worker to touch only
the `pendingEdit` fields on their own closed shifts — never the times, never the
captured evidence.

If workers could edit their own hours directly, every other check in this app
would be decoration. That is the reason the feature is shaped the way it is.

### The daily rental ticket

The report the customer gets is assembled from the day's shifts rather than
written out again by hand. An operator picks the machine they are climbing into
when they clock in; that, and the times, is everything the ticket's table needs:

| Column | Where it comes from |
|---|---|
| Type of equipment, Machine no. | The machine the operator picked at clock-in — preselected from their usual machine, or the only one on the job |
| Name of operator | Their employee record |
| Time in / out, twice | Their shifts that day, in order — the two pairs are the morning and the afternoon, either side of lunch |
| Operator hours | Hours worked, with the four-hour show-up minimum applied |
| Tractor hours | The hour meter, read off the machine by the operator at clock-out or typed in by the supervisor |

One operator gets **one line**, whether they clocked in once or four times. The
day is grouped by person first and split by machine only when they genuinely
moved onto a different one — a stint where nobody picked a machine stays on the
operator's line rather than splitting the day in two over a blank field.

Somebody still on the clock appears on the ticket with the finish time blank and
their hours marked `*`, rather than being left off it. Leaving them off was
worse: whoever forgot to clock out simply vanished from the customer's copy.

Two things are deliberately not automatic. **Tractor hours** default to the
hours worked but are meant to be overwritten: the meter records what the machine
actually ran, which is less than the operator was there for whenever it broke
down or sat waiting on another trade. And the **four-hour minimum never applies
to machine hours** — that minimum is what the yard owes an operator who turned
out, not something to bill a customer for a machine that stood still.

### The supervisor's signature

The ticket is signed on the sheet, where the paper form has its signature line —
with a finger or a stylus. The mark is stored as **stroke paths**, not a picture:
there is no Cloud Storage on this plan, so it has to live inside the ticket
document, and a Firestore document stops at 1 MiB. Strokes come to a few
kilobytes where a bitmap of the same signature is tens, and they stay sharp when
the ticket is printed rather than going soft at 600 pixels wide. The rules cap
how many strokes a ticket can carry, so nobody can push one towards that limit
and wedge the day's report.

The supervisor's name and the time are recorded alongside it — a mark on its own
identifies nobody a year later when the invoice is queried.

A supervisor can **store their signature once** under Account and apply it to a
ticket with one tap. Redrawing the same mark on a phone for every ticket is how
a signature feature stops getting used. Stored on their own employee record,
under a rule that lets them write that field and nothing else — a signature
update cannot carry a promotion along with it — and bounded the same way the
ticket's copy is.

A signature can also be **taken off entirely**, not just replaced: somebody who
signed the wrong day's sheet needs it gone. The name and time go with it, since
leaving those behind would still read as signed on the printed copy.

**Editing a signed ticket clears the signature.** A signature attests to the
figures that were on the sheet when it was signed; keeping it through an edit
would put a supervisor's name against numbers they never saw. Saving a signed
ticket says so and asks for it again.

Rebuilding a ticket re-derives its rows from the timesheet, picking up any
corrections approved since, while keeping the meter readings already typed in.
Saving fixes the ticket number, which is handed out one at a time by a Firestore
transaction so two supervisors saving at once cannot land on the same number.
Set the starting number to carry on from the paper book.

The printed page is the paper form, deliberately: same columns, same conditions
text, same footer. Rental charges are shown on screen for the office and kept
**off** the printed copy, because the form the customer has always been handed is
a record of hours and pricing belongs on the invoice.

### The activity log

Every change is written to an append-only trail: employees added or edited,
job sites and machines, approvals, corrections, tickets saved and signed, and
ownership moving. Anything that moved somebody's hours records what they were
before and what they became, because a log saying only that a shift was edited
answers none of the questions you would ask of it.

The rules stamp each entry with the server's clock and the signed-in account,
and refuse updates and deletes outright — so an entry cannot be altered or
removed afterwards, including by whoever wrote it.

**The honest limit:** with no server, an audit entry cannot be *forced*. The
app writes one for every change it makes, and nothing can tamper with what is
written, but a client that bypassed the app entirely could make a change
without logging it. The changes that matter most are still constrained by the
rules themselves — hours cannot be edited by the worker they belong to, shifts
cannot be deleted by anyone — so the log records who did what, while the rules
decide what anybody is allowed to do at all.

### Owner and supervisors

The company has one **owner**, recorded when it was first claimed. Supervisors
run the yard; the owner decides who the supervisors are.

Only the owner can hand ownership on, and only to somebody who is already an
active supervisor — otherwise a mistyped id would leave the company owned by
nobody. And the owner's account cannot be deactivated or demoted by anyone,
themselves included: ownership moves by being handed on, not by removing the
person holding it. There are tests for each of those.

### Knowing what they clocked in on

Every punch records the handset: a readable name derived from the user agent, a
stable per-browser id shown as a short handle like `D-4F2A9C`, plus the raw user
agent, platform, screen and timezone.

That shows up on the timesheet row, in the evidence view for both punches, and
in the CSV export. When a worker clocks in on one handset and out on another,
the row says so.

The device id lives in the browser's local storage. It is **not** a security
control: clearing site data mints a new one.

---

## What this cannot do

Stated plainly, because the alternative is discovering it later:

- **No photo fallback.** It needs Cloud Storage, which needs Blaze.
- **No automatic close of forgotten shifts.** That was a scheduled function. An
  administrator closes a stuck shift by hand from the **On site** tab; it is
  flagged so it stands out on the timesheet.
- **Deactivating cannot disable the Auth account.** That needs the Admin SDK. A
  deactivated worker can still sign in, but every rule denies them, so they can
  read nothing and write nothing — they see an "account deactivated" screen.
- **Passwords are reset by email link**, not set directly.
- **No impossible-travel or shared-handset detection.** Both need to compare a
  punch against other people's punches, which a client is not allowed to read.
  The device is still recorded on every punch, so the pattern is visible in the
  CSV export.
- **No offline punch queue.** Removed with the offline photo path; the app still
  installs and opens without a connection, but a punch needs a connection.

---

## Layout

```
firestore.rules      the entire enforcement layer — read this first
firestore.indexes.json
firebase.json        hosting config; deploy targets are hosting + firestore
deploy.sh            guided deploy
tests/rules.test.mjs 47 tests against the rules, on the real emulator
web/
  src/lib/actions.ts every write the app makes
  src/lib/policy.ts  thresholds, mirrored by firestore.rules
  src/lib/overtime.ts California overtime
  src/pages/         worker screens and the admin section
  ui-smoke.mjs       end-to-end browser test of the whole flow
```

## Tests

```bash
npm test              # security rules, against the Firestore emulator
npm run emulators     # in one terminal…
npm run test:ui       # …then the browser test in another
npm run test:overtime # California overtime maths
```

`npm test` is the one that matters. With no server, the rules are the only thing
standing between a worker and everyone else's timesheet, so they are tested
against the real emulator rather than reasoned about: bootstrap, roles, the
geofence, one-open-shift, the rate limit, edits, approval, the audit log, and
what a signed-out visitor can reach (nothing).
