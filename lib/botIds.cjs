"use strict";

/**
 * Bot kimlikleri — tek kaynak.
 *
 * İKİ AYRI KAVRAM vardır, karıştırılmamalı:
 *
 *  1) AKTİF KADRO (`BOT_PROFILES`) — data/bot-profiles.json
 *     Her maç için tahmin ÜRETEN botlar. Şema: [{ id, club, segment, tier }]
 *     Sadece pred.cjs'in bot üretim akışı kullanır.
 *
 *  2) KİMLİK KÜMESİ (`isBot` / `BOT_ID_SET`) — bot-profiles.json + bot-legacy-ids.json
 *     "Bu userId insan mı bot mu?" sorusunun cevabı. Puanlama, LC ödülü,
 *     topluluk çarpanı ve seri (streak) hesapları bunu kullanır.
 *
 * Neden ayrı: bot-profiles.json bir dönem daha büyüktü. Liste 1000'e
 * düşürülünce eski botlar kimlik kümesinden de çıktı ve kod onları İNSAN
 * saymaya başladı — topluluk çarpanı bozuldu, settle'da LC aldılar.
 * bot-legacy-ids.json o kimlikleri geri tanıtır ama kadroya sokmaz:
 * emekli botlar yeni tahmin üretmez, sadece bot olarak bilinirler.
 */

const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_PATH = path.join(DATA_DIR, "bot-profiles.json");
const LEGACY_PATH = path.join(DATA_DIR, "bot-legacy-ids.json");

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ── 1) Aktif kadro ──────────────────────────────────────────────────────────
const BOT_PROFILES = [];
{
  const raw = readJsonSync(PROFILES_PATH, null);
  if (Array.isArray(raw)) {
    for (const p of raw) {
      const userId = String((p && (p.id || p.userId)) || "").trim();
      if (!userId) continue;
      BOT_PROFILES.push({
        userId,
        favTeam: p.club || null,
        segment: p.segment || null,
        tier: p.tier || null,
      });
    }
  } else {
    console.warn("[botIds] bot-profiles.json okunamadi veya dizi degil — aktif kadro bos");
  }
}

const BOT_PROFILE_MAP = new Map(BOT_PROFILES.map((b) => [b.userId.toLowerCase(), b]));

// ── 2) Kimlik kümesi (aktif + emekli) ───────────────────────────────────────
const BOT_ID_SET = new Set(BOT_PROFILES.map((b) => b.userId.toLowerCase()));

let legacyCount = 0;
{
  const raw = readJsonSync(LEGACY_PATH, null);
  // Hem { ids: [...] } hem düz [...] kabul edilir
  const ids = Array.isArray(raw) ? raw : raw && Array.isArray(raw.ids) ? raw.ids : [];
  for (const id of ids) {
    const l = String(id || "").trim().toLowerCase();
    if (!l || BOT_ID_SET.has(l)) continue;
    BOT_ID_SET.add(l);
    legacyCount++;
  }
}

console.log(
  `[botIds] aktif kadro: ${BOT_PROFILES.length} · emekli kimlik: ${legacyCount} · toplam bot kimligi: ${BOT_ID_SET.size}`
);

/** Bu userId bir bot mu? (aktif kadro veya emekli — ikisi de bot sayılır) */
function isBot(userId) {
  if (!userId) return false;
  return BOT_ID_SET.has(String(userId).trim().toLowerCase());
}

module.exports = {
  // aktif kadro — sadece tahmin üretimi için
  BOT_PROFILES,
  BOT_PROFILE_MAP,
  // kimlik — puanlama/ödül/çarpan filtreleri için
  BOT_ID_SET,
  isBot,
};
