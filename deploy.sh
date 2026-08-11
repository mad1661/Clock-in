#!/usr/bin/env bash
#
# Deploy for the Coburn time clock.
#
# There are no Cloud Functions and no Cloud Storage: this runs entirely on the
# free Spark plan, so a deploy is just two things — the security rules and the
# website. Safe to re-run.
#
#   ./deploy.sh                 # deploy everything
#   ./deploy.sh --project foo   # skip the project prompt
#   ./deploy.sh --hosting-only  # just rebuild and push the website
#   ./deploy.sh --api-key AIza… # use this browser API key instead of the one
#                               # the project reports (see "API key" below)

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
API_KEY_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --project=*) PROJECT="${1#*=}"; shift ;;
    --api-key) API_KEY_OVERRIDE="${2:-}"; shift 2 ;;
    --api-key=*) API_KEY_OVERRIDE="${1#*=}"; shift ;;
    --hosting-only) HOSTING_ONLY=true; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
step "Checking your tools"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get it from https://nodejs.org (version 20 or newer)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js $NODE_MAJOR is too old. Install version 20 or newer from https://nodejs.org."
fi
ok "Node.js $(node -v)"

if ! command -v firebase >/dev/null 2>&1; then
  warn "The Firebase CLI is not installed."
  info "Installing it now with: npm install -g firebase-tools"
  npm install -g firebase-tools || die "Could not install firebase-tools. Try again with sudo, or see https://firebase.google.com/docs/cli"
fi
ok "Firebase CLI $(firebase --version)"

if [ -n "${FIREBASE_TOKEN:-}" ] || [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  ok "Using Firebase credentials from the environment"
elif firebase login:list 2>/dev/null | grep -qi 'logged in as'; then
  ok "Signed in to Firebase"
else
  step "Signing in to Firebase"
  info "A browser window will open. Sign in with the Google account that owns the project."
  firebase login || die "Sign-in failed. Run 'firebase login' by hand and try again."
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

# `apps:sdkconfig` is the same values the console shows under Project settings,
# so nobody has to copy-paste them by hand.
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
for (const key of ['apiKey', 'authDomain', 'projectId', 'appId']) {
  if (!cfg[key]) {
    console.error(`Missing ${key} in the web app config`);
    process.exit(1);
  }
}
process.stdout.write(
  [
    '# Generated by deploy.sh from your Firebase web app config.',
    '# Not secret — these ship in the browser bundle by design. Access is',
    '# controlled by firestore.rules, not by hiding these strings.',
    `VITE_FIREBASE_API_KEY=${cfg.apiKey}`,
    `VITE_FIREBASE_AUTH_DOMAIN=${cfg.authDomain}`,
    `VITE_FIREBASE_PROJECT_ID=${cfg.projectId}`,
    `VITE_FIREBASE_MESSAGING_SENDER_ID=${cfg.messagingSenderId ?? ''}`,
    `VITE_FIREBASE_APP_ID=${cfg.appId}`,
    'VITE_USE_EMULATORS=false',
    '',
  ].join('\n'),
);
NODE

if [ -n "$API_KEY_OVERRIDE" ]; then
  # Deliberately after the generated file, so an explicitly supplied key always
  # wins over whatever the project reports.
  sed -i.bak "s|^VITE_FIREBASE_API_KEY=.*|VITE_FIREBASE_API_KEY=${API_KEY_OVERRIDE}|" web/.env
  rm -f web/.env.bak
  info "Using the API key given on the command line"
fi
ok "Wrote web/.env"

# ---------------------------------------------------------------------------
step "Checking the API key actually works"

# `apps:sdkconfig` reports the key recorded against the Firebase web app, which
# keeps returning a key string even after that key has been deleted in the
# Google Cloud console. Deploying then produces a site that loads perfectly and
# that nobody on earth can sign in to. One request catches it here instead.
API_KEY="$(grep '^VITE_FIREBASE_API_KEY=' web/.env | cut -d= -f2-)"
KEY_PROBE="$(curl -sS -m 20 \
  "https://identitytoolkit.googleapis.com/v1/recaptchaParams?key=${API_KEY}" 2>/dev/null || true)"

case "$KEY_PROBE" in
  *API_KEY_INVALID*|*"API key not valid"*)
    die "The Firebase API key for this project is not valid, so nobody would be
  able to sign in to the site this script is about to build.

  Key tried: ${API_KEY}

  This almost always means the browser API key was deleted in the Google Cloud
  console. Firebase keeps reporting the old key string, so redeploying cannot
  fix it on its own.

  Fix it like this:

  1. Open the credentials page for the project:
     https://console.cloud.google.com/apis/credentials?project=${PROJECT}
  2. If a deleted key is offered for restore, restore it. Otherwise click
     Create credentials → API key, and copy the new key.
  3. Re-run with that key:
     ./deploy.sh --api-key THE_NEW_KEY

  Do not confuse this with a service account key (Firebase console → Project
  settings → Service accounts). They are different objects on different pages,
  and deleting the wrong one causes exactly this."
    ;;
  "")
    warn "Could not reach Google to check the API key — carrying on."
    ;;
  *)
    ok "API key accepted by Firebase Authentication"
    ;;
esac

# ---------------------------------------------------------------------------
step "Installing and building"

npm --prefix web install --no-audit --no-fund >/dev/null || die "npm install failed in web/"
ok "Dependencies installed"

npm --prefix web run build >/dev/null || die "The website failed to build. Run 'npm --prefix web run build' to see the error."
ok "Website built"

if [ "$HOSTING_ONLY" = true ]; then
  step "Deploying the website only"
  firebase deploy --only hosting --project "$PROJECT" || die "Hosting deploy failed."
  ok "Done: https://${PROJECT}.web.app"
  exit 0
fi

# ---------------------------------------------------------------------------
# One target at a time, so a failure names the console page that fixes it
# rather than scrolling past in one wall of output.
# ---------------------------------------------------------------------------

step "Deploying the security rules"
# These rules are the entire server. Nothing else enforces who may clock in,
# from where, or whose hours they can see — so this step is not optional.
if ! firebase deploy --only firestore --project "$PROJECT"; then
  die "Firestore deploy failed.
  Most likely the database has not been created yet.
  Fix: https://console.firebase.google.com/project/$PROJECT/firestore
       → Create database → Production mode → pick a region."
fi
ok "Rules and indexes deployed"

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

  4. Add a job site, then add your crew under Employees.

  ${dim}Re-run ./deploy.sh any time to push changes. ./deploy.sh --hosting-only
  is enough when you have only touched the website.${reset}

EOF
