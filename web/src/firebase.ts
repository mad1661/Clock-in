import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, connectAuthEmulator, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

const required = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

const missing = required.filter((key) => !import.meta.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Firebase is not configured. Missing ${missing.join(', ')}. ` +
      'Copy web/.env.example to web/.env and fill it in (see SETUP.md).',
  );
}

const config: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(config);

// App Check attests that writes come from this app in a real browser, which
// raises the cost of scripting Firestore directly with a stolen ID token.
// reCAPTCHA v3 rather than Enterprise: v3 is free and works on the Spark plan.
// Optional, so the app runs before you have registered a key.
const recaptchaKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
if (recaptchaKey) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(recaptchaKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
export const db = getFirestore(app);

// Workers stay signed in between shifts; asking a crew to type a password every
// morning on a cold site is how you end up with shared logins.
void setPersistence(auth, browserLocalPersistence);

/** True when this build talks to the local emulator suite instead of Firebase. */
export const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
