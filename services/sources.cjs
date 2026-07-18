"use strict";

/**
 * ══════════════════════════════════════════════════════════════
 *  SkorLig VERİ KAYNAKLARI — KADEME (CASCADE) KAYDI
 * ══════════════════════════════════════════════════════════════
 *
 * Mantık: Ücretsiz kaynaklar önce denenir, ücretli API'ler son çare.
 * Bir kaynak veri döndüremezse (fail / kota dolu / maç bulunamadı)
 * bir sonraki kademeye düşülür.
 *
 * Yeni scraper eklemek:
 *   1. services/scrapers/<id>.cjs dosyasını yaz (mackolik.cjs örnek)
 *   2. Aşağıdaki SOURCES listesine bir satır ekle
 *   3. status: "active" yap
 *
 * Kademe (tier) küçükten büyüğe denenir: 1 → 2 → 3
 */

const SOURCES = [
  // ─── TIER 1: Ücretsiz Scraper'lar (öncelikli) ───────────────
  {
    id: "mackolik",
    name: "Maçkolik",
    tier: 1,
    kind: "scraper",
    status: "active",
    url: "https://www.mackolik.com/canli-sonuclar",
    module: "./livescore-scraper.cjs",
    provides: ["live", "results"],   // canlı skor + maç sonucu
    notes: "Puppeteer ile scrape. Türk ligleri güçlü. Chrome gerekir (Render'da chromium eklenmeli).",
  },
  {
    id: "bilyoner",
    name: "Bilyoner",
    tier: 1,
    kind: "scraper",
    status: "planned",
    url: "https://www.bilyoner.com/iddaa",
    module: "./scrapers/bilyoner.cjs",
    provides: ["fixtures", "odds"],  // gelecek maçlar + oran
    notes: "Program/fikstür için iyi. Oran verisi de var. Henüz yazılmadı.",
  },
  {
    id: "skorx",
    name: "SkorX",
    tier: 1,
    kind: "scraper",
    status: "planned",
    url: "https://www.skorx.com",
    module: "./scrapers/skorx.cjs",
    provides: ["live", "results"],
    notes: "Maçkolik'e yedek canlı skor kaynağı. Henüz yazılmadı.",
  },

  // ─── TIER 2: Ücretsiz API ────────────────────────────────────
  {
    id: "tsdb",
    name: "TheSportsDB",
    tier: 2,
    kind: "api",
    status: "active",
    url: "https://www.thesportsdb.com/api",
    envKey: null,                    // ücretsiz katman key gerektirmez
    provides: ["fixtures", "results", "teams"],
    quota: { daily: 1000 },
    notes: "Ücretsiz API. Global kapsama orta. Logo/takım bilgisi iyi.",
  },

  // ─── TIER 3: Ücretli API (son çare) ──────────────────────────
  {
    id: "af",
    name: "API-Football",
    tier: 3,
    kind: "api",
    status: "active",
    url: process.env.AF_BASE || "https://v3.football.api-sports.io",
    envKey: "AF_KEY",
    provides: ["fixtures", "live", "results", "teams", "leagues"],
    quota: { daily: 100 },
    notes: "En kapsamlı ama günde 100 istek (ücretsiz tier). Kota korumalı kullan.",
  },
  {
    id: "fdo",
    name: "football-data.org",
    tier: 3,
    kind: "api",
    status: "active",
    url: process.env.FDO_BASE || "https://api.football-data.org/v4",
    envKey: "FDO_KEY",
    provides: ["fixtures", "results", "leagues"],
    quota: { daily: 1000 },
    notes: "Büyük Avrupa ligleri iyi. Canlı skor yok, program/sonuç için.",
  },
];

/**
 * Belirli bir veri tipini (live/fixtures/results/...) sağlayan
 * AKTİF kaynakları kademe sırasına göre döndürür.
 */
function activeSourcesFor(dataType) {
  return SOURCES
    .filter(s => s.status === "active" && s.provides.includes(dataType))
    .sort((a, b) => a.tier - b.tier);
}

/** Tüm kaynakları döndürür (admin panel / debug için). */
function allSources() {
  return SOURCES.map(s => ({
    id: s.id, name: s.name, tier: s.tier, kind: s.kind,
    status: s.status, provides: s.provides, notes: s.notes,
  }));
}

/** Tek bir kaynağı id ile getirir. */
function getSource(id) {
  return SOURCES.find(s => s.id === id) || null;
}

module.exports = { SOURCES, activeSourcesFor, allSources, getSource };
