// Firebase project "Dubs" (dubs-d46eb). These values identify the project; they're meant to be
// public and ship with the website. What protects the data is Firestore's security rules
// (firestore.rules), not keeping this file secret.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBtMKXnF5FTxnHjg9Ra6ZnkY6QeK0_fAw4',
  authDomain: 'dubs-d46eb.firebaseapp.com',
  projectId: 'dubs-d46eb',
  storageBucket: 'dubs-d46eb.firebasestorage.app',
  messagingSenderId: '485266990057',
  appId: '1:485266990057:web:a747e3f14fe637fdcba178',
};

// Public "Web Push certificate" key (Firebase console → Project settings → Cloud Messaging).
// Phones use it to sign up for push notifications; it's meant to be public.
export const VAPID_KEY = 'BKQUJ-7cSdpEmF7yIL9sKeKHxm4i1-Ro_xigNtLLsHQ8KnXYxupJE0Nvs5nRSUqunpDAFS3JXIpzyi1mOXrT87U';
