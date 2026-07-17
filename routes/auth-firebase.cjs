"use strict";

const express = require("express");
const router  = express.Router();
const { verifyToken } = require("../middleware/verifyToken.cjs");

// Kimlik doğrulama testi + profil bilgisi
// x-auth-token header'ı ile Firebase ID token gönderilir
router.get("/me", verifyToken, (req, res) => {
  res.json({
    ok: true,
    uid:   req.uid,
    email: req.firebaseUser?.email || null,
    name:  req.firebaseUser?.name || null,
    photo: req.firebaseUser?.picture || null,
  });
});

module.exports = router;
