// The one setting you need to change. Paste your Apps Script web app URL here (see SETUP.md).
// It ends in /exec. While this is empty, the app runs in demo mode: two sample players,
// sample games, and everything stored in this browser only.
export const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxYrSUcvD6h6DhpgsAqHTkK2mZ5QfMQoTqQ1zDw8uI6TUvvJjVfnNNn_FuIvWsiulWwig/exec',

  // Where the data lives: 'sheets' (the Google Sheet through Apps Script) or 'firebase'
  // (Firebase Auth + Firestore, see firebase-config.js). With 'firebase', APPS_SCRIPT_URL is still
  // used once per player: the first sign-in after the move checks their old PIN.
  BACKEND: 'firebase',

  // How often to check for new games while the app is open.
  POLL_SECONDS: 25,
};
