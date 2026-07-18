"use strict";

// Firebase Admin SDK token doğrulama (modüler API — firebase-admin v12+)
// Yerel: firebase-service-account.json  |  Prod: FIREBASE_SERVICE_ACCOUNT_JSON env

const path = require("path");
const fs   = require("fs");

let _auth = null;
let _initTried = false;

function getFirebaseAuth() {
  if (_auth) return _auth;
  if (_initTried) return _auth; // bir kez denendi, yoksa null kalsın
  _initTried = true;

  try {
    const { initializeApp, cert, applicationDefault, getApps } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");

    if (!getApps().length) {
      const filePath = path.join(__dirname, "..", "firebase-service-account.json");
      const envJson  = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const envB64   = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

      if (fs.existsSync(filePath)) {
        initializeApp({ credential: cert(require(filePath)) });
      } else if (envB64) {
        // Base64-encoded JSON (Render env variable için stabil)
        const decoded = Buffer.from(envB64, 'base64').toString('utf-8');
        initializeApp({ credential: cert(JSON.parse(decoded)) });
      } else if (envJson) {
        initializeApp({ credential: cert(JSON.parse(envJson)) });
      } else {
        initializeApp({ credential: applicationDefault() });
      }
    }
    _auth = getAuth();
    console.log("[verifyToken] firebase-admin initialized");
  } catch (e) {
    console.warn("[verifyToken] firebase-admin init failed:", e.message);
    _auth = null;
  }
  return _auth;
}

/**
 * Zorunlu kimlik: x-auth-token doğrulanır, req.uid set edilir.
 * Token yok/geçersizse 401.
 */
async function verifyToken(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token) {
    return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
  }

  const fbAuth = getFirebaseAuth();
  if (!fbAuth) {
    // firebase-admin yoksa dev fallback (prod'da olmaz)
    console.warn("[verifyToken] no firebase-admin — dev fallback");
    req.uid = req.headers["x-user-id"] || "dev";
    return next();
  }

  try {
    const decoded    = await fbAuth.verifyIdToken(token);
    req.uid          = decoded.uid;
    req.firebaseUser = decoded;
    next();
  } catch (e) {
    console.warn("[verifyToken] invalid token:", e.message);
    return res.status(401).json({ ok: false, error: "INVALID_TOKEN" });
  }
}

/**
 * Opsiyonel kimlik: token varsa doğrula, yoksa anonim geç.
 */
async function optionalToken(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token) { req.uid = null; return next(); }

  const fbAuth = getFirebaseAuth();
  if (!fbAuth) { req.uid = req.headers["x-user-id"] || null; return next(); }

  try {
    const decoded    = await fbAuth.verifyIdToken(token);
    req.uid          = decoded.uid;
    req.firebaseUser = decoded;
  } catch {
    req.uid = null;
  }
  next();
}

module.exports = { verifyToken, optionalToken, getFirebaseAuth };
