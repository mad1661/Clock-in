#!/usr/bin/env bash
#
# Guided deploy for the Coburn time clock.
#
# Safe to re-run: every step is idempotent, and each one that can fail because
# of a missing console setting says exactly which page to go and fix.
#
#   ./deploy.sh                 # deploy everything
#   ./deploy.sh --project foo   # skip the project prompt
#   ./deploy.sh --hosting-only  # just rebuild and push the website

set -euo pipefail
cd "$(dirname "$0")"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'
yellow=$'\033[33m'; blue=$'\033[34m'; reset=$'\033[0m'

step()  { printf '\n%s==> %s%s\n' "$bold$blue" "$1" "$reset"; }
ok()    { printf '%s  ✓ %s%s\n' "$green" "$1" "$reset"; }
warn()  { printf '%s  ! %s%s\n' "$yellow" "$1" "$reset"; }
info()  { printf '%s    %s%s\n' "$dim" "$1" "$reset"; }
die()   { printf '\n%s  ✗ %s%s\n\n' "$red$bold" "$1" "$reset" >&2; exit 1; }

PROJECT=""
HOSTING_ONLY=false
SCHEDULER_PENDING=false
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --project=*) PROJECT="${1#*=}"; shift ;;
    --hosting-only) HOSTING_ONLY=true; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
step "Checking your tools"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get it from https://nodejs.org (version 20 or newer)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  if [ -n "${CLOUD_SHELL:-}" ] || [ -n "${DEVSHELL_PROJECT_ID:-}" ]; then
    die "Node.js $NODE_MAJOR is too old. In Cloud Shell, run:
    nvm install 22 && nvm use 22
  then re-run ./deploy.sh"
  fi
  die "Node.js $NODE_MAJOR is too old. Install version 20 or newer from https://nodejs.org."
fi
ok "Node.js $(node -v)"

if ! command -v firebase >/dev/null 2>&1; then
  warn "The Firebase CLI is not installed."
  info "Installing it now with: npm install -g firebase-tools"
  npm install -g firebase-tools || die "Could not install firebase-tools. Try again with sudo, or see https://firebase.google.com/docs/cli"
fi
ok "Firebase CLI $(firebase --version)"

IN_CLOUD_SHELL=false
[ -n "${CLOUD_SHELL:-}" ] || [ -n "${DEVSHELL_PROJECT_ID:-}" ] && IN_CLOUD_SHELL=true
[ "$IN_CLOUD_SHELL" = true ] && ok "Running in Google Cloud Shell"

if [ -n "${FIREBASE_TOKEN:-}" ] || [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  ok "Using Firebase credentials from the environment"
elif firebase login:list 2>/dev/null | grep -qi 'logged in as'; then
  ok "Signed in to Firebase"
else
  step "Signing in to Firebase"
  if [ "$IN_CLOUD_SHELL" = true ]; then
    # Cloud Shell cannot open a callback on localhost; this prints a link to
    # tap and a code to paste back, which works on a phone.
    info "Tap the link that appears, pick your Google account, then paste the code back here."
    firebase login --no-localhost || die "Sign-in failed. Run 'firebase login --no-localhost' by hand and try again."
  else
    info "A browser window will open. Sign in with the Google account that owns the project."
    firebase login || die "Sign-in failed. Run 'firebase login' by hand and try again."
  fi
  ok "Signed in to Firebase"
fi

# ---------------------------------------------------------------------------
step "Choosing the Firebase project"

if [ -z "$PROJECT" ] && [ -f .firebaserc ]; then
  PROJECT="$(node -p "try{require('./.firebaserc').projects.default||''}catch(e){''}" 2>/dev/null || echo "")"
  [ -n "$PROJECT" ] && info "Using the project already set in .firebaserc"
fi

if [ -z "$PROJECT" ]; then
  echo
  firebase projects:list 2>/dev/null || warn "Could not list your projects — you can still type the id below."
  echo
  printf '%sProject ID (from the Firebase console, not the display name): %s' "$bold" "$reset"
  read -r PROJECT
  [ -n "$PROJECT" ] || die "No project id given."
fi

firebase use "$PROJECT" >/dev/null 2>&1 \
  || die "Could not select project '$PROJECT'. Check the id at https://console.firebase.google.com and that your account has access."
ok "Project: $PROJECT"

cat > .firebaserc <<EOF
{
  "projects": {
    "default": "$PROJECT"
  }
}
EOF

# ---------------------------------------------------------------------------
step "Reading your web app config"

# `apps:sdkconfig` is the same six values the console shows under Project
# settings, so nobody has to copy-paste them by hand.
SDK_JSON="$(firebase apps:sdkconfig web --project "$PROJECT" --json 2>/dev/null || true)"

has_config() {
  node -e '
    try {
      const j = JSON.parse(process.argv[1] || "");
      const c = j?.result?.sdkConfig ?? j?.result ?? j?.sdkConfig ?? j;
      process.exit(c && c.apiKey && c.appId ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1"
}

if ! has_config "$SDK_JSON"; then
  warn "No web app registered in this project yet — creating one."
  firebase apps:create web "Coburn Time Clock" --project "$PROJECT" >/dev/null \
    || die "Could not create a web app. Register one by hand: Firebase console → Project settings → Your apps → Web."
  SDK_JSON="$(firebase apps:sdkconfig web --project "$PROJECT" --json 2>/dev/null || true)"
fi

has_config "$SDK_JSON" || die "Could not read the web app config.
  Register a web app by hand and re-run:
  Firebase console → Project settings → Your apps → Web (</>)."

node - "$SDK_JSON" <<'NODE' > web/.env || die "Could not write web/.env."
const parsed = JSON.parse(process.argv[2]);
const cfg = parsed?.result?.sdkConfig ?? parsed?.result ?? parsed?.sdkConfig ?? parsed;
const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'appId'];
for (const key of required) {
  if (!cfg[key]) {
    console.error(`Missing ${key} in the web app config`);
    process.exit(1);
  }
}
process.stdout.write(
  [
    '# Generated by deploy.sh from your Firebase web app config.',
    '# Safe to commit? No - it is gitignored. Not secret either; these ship in the bundle.',
    `VITE_FIREBASE_API_KEY=${cfg.apiKey}`,
    `VITE_FIREBASE_AUTH_DOMAIN=${cfg.authDomain}`,
    `VITE_FIREBASE_PROJECT_ID=${cfg.projectId}`,
    `VITE_FIREBASE_STORAGE_BUCKET=${cfg.storageBucket}`,
    `VITE_FIREBASE_MESSAGING_SENDER_ID=${cfg.messagingSenderId ?? ''}`,
    `VITE_FIREBASE_APP_ID=${cfg.appId}`,
    'VITE_FUNCTIONS_REGION=us-central1',
    'VITE_USE_EMULATORS=false',
    '',
  ].join('\n'),
);
NODE

BUCKET="$(grep '^VITE_FIREBASE_STORAGE_BUCKET=' web/.env | cut -d= -f2-)"
ok "Wrote web/.env"
info "Storage bucket: $BUCKET"

# ---------------------------------------------------------------------------
step "Installing and building"

npm --prefix functions install --no-audit --no-fund >/dev/null || die "npm install failed in functions/"
npm --prefix web install --no-audit --no-fund >/dev/null || die "npm install failed in web/"
ok "Dependencies installed"

npm --prefix functions run build >/dev/null || die "The Cloud Functions failed to compile. Run 'npm --prefix functions run build' to see the error."
ok "Functions compiled"

npm --prefix web run build >/dev/null || die "The website failed to build. Run 'npm --prefix web run build' to see the error."
ok "Website built"

if [ "$HOSTING_ONLY" = true ]; then
  step "Deploying the website only"
  firebase deploy --only hosting --project "$PROJECT" || die "Hosting deploy failed."
  ok "Done: https://${PROJECT}.web.app"
  exit 0
fi

# ---------------------------------------------------------------------------
# Deployed one target at a time. A single `firebase deploy` gives one wall of
# output where a missing console setting is easy to miss; this way each failure
# names the page that fixes it.
# ---------------------------------------------------------------------------

step "Deploying database rules and indexes"
if ! firebase deploy --only firestore --project "$PROJECT"; then
  die "Firestore deploy failed.
  Most likely the database has not been created yet.
  Fix: https://console.firebase.google.com/project/$PROJECT/firestore
       → Create database → Production mode → pick a region."
fi
ok "Firestore rules and indexes deployed"

step "Deploying storage rules"
if ! firebase deploy --only storage --project "$PROJECT"; then
  die "Storage deploy failed.
  Most likely Cloud Storage has not been set up yet. New projects need the
  Blaze plan before Firebase will create the default bucket.
  Fix: 1. https://console.firebase.google.com/project/$PROJECT/usage/details
          → upgrade to Blaze (pay as you go)
       2. https://console.firebase.google.com/project/$PROJECT/storage
          → Get started → Production mode → same region as Firestore
  Then re-run ./deploy.sh — everything already done will be skipped."
fi
ok "Storage rules deployed"

step "Deploying Cloud Functions (this is the slow one)"
if ! firebase deploy --only functions --project "$PROJECT"; then
  # The one function that needs an extra Google Cloud API is the nightly sweep,
  # and the app works fine without it. Rather than let that block the whole
  # deploy on a fresh project, retry with everything else and say so.
  warn "The functions deploy failed. Retrying without the nightly auto-close,"
  warn "which is the one piece that needs the Cloud Scheduler API."

  CALLABLES="$(node -e "
    const s = require('fs').readFileSync('functions/src/index.ts', 'utf8');
    const names = [...s.matchAll(/export\s*\{([^}]*)\}/g)]
      .flatMap((m) => m[1].split(','))
      .map((x) => x.trim())
      .filter(Boolean);
    console.log(names.filter((n) => n !== 'autoCloseStaleShifts').map((n) => 'functions:' + n).join(','));
  ")"

  if [ -n "$CALLABLES" ] && firebase deploy --only "$CALLABLES" --project "$PROJECT"; then
    warn "Everything deployed except the nightly auto-close of forgotten shifts."
    info "The app is fully usable. To finish the job:"
    info "  1. Enable Cloud Scheduler:"
    info "     https://console.cloud.google.com/apis/library/cloudscheduler.googleapis.com?project=$PROJECT"
    info "  2. Wait a minute, then re-run ./deploy.sh"
    SCHEDULER_PENDING=true
  else
    die "Functions deploy failed. The usual causes, in order of likelihood:
  1. The project is still on the free Spark plan. Cloud Functions needs Blaze:
     https://console.firebase.google.com/project/$PROJECT/usage/details
  2. A required Google Cloud API is not enabled yet. The error above names it —
     open the link it prints, click Enable, wait a minute, and re-run this script.
  3. A transient build error on Google's side. Re-running usually clears it."
  fi
else
  ok "Cloud Functions deployed"
fi

step "Deploying the website"
firebase deploy --only hosting --project "$PROJECT" || die "Hosting deploy failed."
ok "Website deployed"

# ---------------------------------------------------------------------------
printf '\n%s%s  Deployed.%s\n\n' "$bold" "$green" "$reset"
printf '  %sYour site:%s https://%s.web.app\n\n' "$bold" "$reset" "$PROJECT"

cat <<EOF
  ${bold}One-time setup, if you have not done it yet${reset}

  1. Turn on email sign-in:
     https://console.firebase.google.com/project/$PROJECT/authentication/providers
     → Email/Password → Enable → Save

  2. Create your own login:
     https://console.firebase.google.com/project/$PROJECT/authentication/users
     → Add user → your email and a password

  3. Open https://$PROJECT.web.app, sign in with it, and tap
     "Make me the administrator" on the setup screen.

  4. Add a job site, then add your crew under Workers.

  ${dim}Re-run ./deploy.sh any time to push changes. ./deploy.sh --hosting-only
  is enough when you have only touched the website.${reset}

EOF

if [ "$SCHEDULER_PENDING" = true ]; then
  warn "Reminder: the nightly auto-close is not deployed yet — see above."
fi
