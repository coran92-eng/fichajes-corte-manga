import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getFirestore, enableMultiTabIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";

// Tu configuración de Firebase
const firebaseConfig = {
  apiKey: "AIzaSyD5MT5xerfNcsnEtSWw_qgZvjdJXMP7hnk",
  authDomain: "fichaje-cortedemanga.firebaseapp.com",
  projectId: "fichaje-cortedemanga",
  storageBucket: "fichaje-cortedemanga.firebasestorage.app",
  messagingSenderId: "1096116703696",
  appId: "1:1096116703696:web:09b41a3a3c0955b67869d5",
  measurementId: "G-HRNZZFDJ7E"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Habilitar persistencia offline para que funcione sin internet
try {
  await enableMultiTabIndexedDbPersistence(db);
  console.log("Persistencia offline habilitada");
} catch (err) {
  if (err.code == 'failed-precondition') {
    console.warn("Múltiples pestañas abiertas, persistencia solo en una.");
  } else if (err.code == 'unimplemented') {
    console.warn("El navegador actual no soporta persistencia offline.");
  }
}

export { app, db, auth };
