# Deploy the Coburn time clock

This walkthrough runs in Google Cloud Shell — a real terminal in your browser
that is already signed in to your Google account. It works fine on a phone.

**Every command below has a copy button.** Tap it, then tap Enter in the
terminal. Your project (`clockit-bc990`) is already set in the repo, so you should not
need to type anything at all.

Turn your phone sideways first — the terminal is much easier in landscape.

## Before you start

Your project **`clockit-bc990`** already exists and has a web app registered — that is
where the config came from. Four things still need switching on. Each link goes
straight to the right page.

1. **[Upgrade to Blaze](https://console.firebase.google.com/project/clockit-bc990/usage/details)**
   — Cloud Functions and Cloud Storage both require it. A crew of a few dozen
   stays inside the free monthly allowance; set a $10 budget alert here if you
   want a hard backstop.
2. **[Turn on Email/Password sign-in](https://console.firebase.google.com/project/clockit-bc990/authentication/providers)**
   — Get started → Email/Password → Enable → Save.
3. **[Create the Firestore database](https://console.firebase.google.com/project/clockit-bc990/firestore)**
   — Create database → **Production mode** → region `us-west1` (closest to
   Chino). The region is permanent.
4. **Storage — skip it.** It only backs the photo fallback, which ships switched
   off. Add it later from **Workers → Company settings** when you want that
   upgrade; the deploy handles its absence and tells you.

If any of these are already done, skip them. Click **Next** when they are all on.

## Get the code

If Cloud Shell has not already cloned the repository for you, do it now:

```bash
git clone https://github.com/mad1661/Clock-in.git
```

GitHub will ask you to sign in, because the repository is private. Follow the
prompt in the browser.

Then move into the folder:

```bash
cd Clock-in
```

Click **Next**.

## Check Node is new enough

Cloud Shell sometimes starts on an older Node. This makes sure it is on 22:

```bash
nvm install 22 && nvm use 22
```

Click **Next**.

## Deploy

```bash
./deploy.sh
```

The script will:

1. **Ask you to sign in to Firebase.** It prints a link and a code — tap the
   link, choose your Google account, copy the code it gives you back, and paste
   it into the terminal. This is the only thing it needs from you.
2. Pick up `clockit-bc990` automatically from the repo.
3. Everything else is automatic: it reads your web app config out of the
   project, writes the config file, installs, builds, and deploys the rules,
   indexes, functions and website.

The functions step is slow — three to five minutes on a first deploy is normal.

**If a step fails**, the script prints the exact console page that fixes it.
The two most likely on a fresh project are Storage not being set up, and the
Blaze upgrade not having gone through. Fix it and run `./deploy.sh` again —
re-running is safe, and anything already deployed is skipped.

Click **Next** when it finishes.

## Make yourself the administrator

Your site is now live at **https://clockit-bc990.web.app**

There is no sign-up page — administrators create every account — so the first
one is made by hand, once:

1. **[Authentication → Users → Add user](https://console.firebase.google.com/project/clockit-bc990/authentication/users)**.
   Your email and a password.
2. Open your site, sign in with those details.
3. You will land on a **Set up your company** screen. Enter your name and tap
   **Make me the administrator**.

That door closes behind you: the function refuses to run once any administrator
exists, so nobody can use it to promote themselves later.

Click **Next**.

## Set up your crew

1. **Job sites → + Add site.** Search the address, tap the satellite map, or
   stand in the middle of the site and tap **Use my current location**. The blue
   circle is the boundary, drawn to scale — check it covers the working area.
   150 m suits most sites; too tight and honest workers keep getting flagged.
2. **Workers → + Add employee.** Each one gets a one-time password shown to you
   **once** — copy it before closing the dialog. Nothing is emailed.
3. Tell the crew to open the site and **Add to Home Screen**. It then opens like
   an app and keeps working when they have no signal.

## Done

To deploy again later, from anywhere:

```bash
cd ~/Clock-in && git pull && ./deploy.sh
```

Or `./deploy.sh --hosting-only` when you have only changed the website.

Worth doing once the app is running: turn on **App Check** (see `SETUP.md`). It
stops anyone calling the API from a script rather than the real app.
