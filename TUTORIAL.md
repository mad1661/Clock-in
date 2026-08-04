# Deploy the Coburn time clock

This walkthrough runs in Google Cloud Shell — a real terminal in your browser
that is already signed in to your Google account. It works fine on a phone.

**Every command below has a copy button.** Tap it, then tap Enter in the
terminal. You should not need to type anything except your project ID.

Turn your phone sideways first — the terminal is much easier in landscape.

## Before you start

You need five things done in the Firebase console. If you have already done
them, skip to the next step.

1. A project at <https://console.firebase.google.com> → **Add project**
2. **⚙ Usage and billing → Modify plan → Blaze.** Cloud Functions and Cloud
   Storage both require it. A crew of a few dozen stays inside the free monthly
   allowance — set a $10 budget alert while you are there if you want a backstop.
3. **Build → Authentication → Get started → Email/Password → Enable**
4. **Build → Firestore Database → Create database → Production mode**, region
   `us-west1` (closest to Chino)
5. **Build → Storage → Get started → Production mode**, same region

Write down the **project ID** from **⚙ Project settings** — the lowercase one,
sometimes with digits on the end. Not the display name.

Click **Next** when those are done.

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
   it into the terminal.
2. **Ask for your project ID.** Type it and press Enter.
3. Do everything else: read your web app config out of the project, write the
   config file, install, build, and deploy the rules, indexes, functions and
   website.

The functions step is slow — three to five minutes on a first deploy is normal.

**If a step fails**, the script prints the exact console page that fixes it.
The two most likely on a fresh project are Storage not being set up, and the
Blaze upgrade not having gone through. Fix it and run `./deploy.sh` again —
re-running is safe, and anything already deployed is skipped.

Click **Next** when it finishes.

## Make yourself the administrator

Your site is now live at `https://<project-id>.web.app`.

There is no sign-up page — administrators create every account — so the first
one is made by hand, once:

1. Firebase console → **Authentication → Users → Add user**. Your email and a
   password.
2. Open your site, sign in with those details.
3. You will land on a **Set up your company** screen. Enter your name and tap
   **Make me the administrator**.

That door closes behind you: the function refuses to run once any administrator
exists, so nobody can use it to promote themselves later.

Click **Next**.

## Set up your crew

1. **Job sites → + Add site.** Stand in the middle of the site and tap
   **Use my current location**, or paste coordinates. 150 m is a sensible
   boundary — too tight and honest workers get pushed to the photo fallback.
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
