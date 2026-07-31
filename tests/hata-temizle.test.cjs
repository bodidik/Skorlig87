"use strict";

/**
 * HATA AYRINTISI TEMİZLEME.
 *
 * ⚠️ BULUNAN: 22 dosyada 100 uç hatayı olduğu gibi döndürüyor
 * (`detail: String(e?.message || e)`). Ölçüldü:
 *
 *   dosya hatası → "ENOENT: ... open 'D:\APPden\SkorLig\api\data\x.json'"
 *   Mongo hatası → "querySrv ENOTFOUND _mongodb._tcp.<kume>.mongodb.net"
 *
 * Mutlak sunucu yolu ve ATLAS KÜME ADRESİ dışarı sızıyordu. Parola sızmıyor
 * (sürücü maskeliyor) ama küme adresi, IP listesi denemesi için gerçek bir
 * hedef — ve kullanıcıya hiçbir şey ifade etmiyor.
 *
 * ⚠️ TEK ÇIKIŞ NOKTASI. 100 çağrı yerini tek tek değiştirmek, bu oturumda
 * defalarca görülen "birinde unutulur" hatasına davetiye olurdu. Temizlik
 * yanıt yazılırken bir kez yapılıyor; yeni uçlar kendiliğinden kapsanıyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { temizle, govdeyiTemizle, hataTemizleyici } = require("../lib/hata-temizle.cjs");

test("mutlak sunucu yolları maskelenir", () => {
  const win = String.raw`ENOENT: no such file or directory, open 'D:\APPden\SkorLig\api\data\x.json'`;
  assert.ok(!temizle(win).includes("APPden"), "Windows yolu siziyor");

  const posix = "ENOENT: open /opt/render/project/src/api/data/preds.json";
  assert.ok(!temizle(posix).includes("/opt/render"), "Render yolu siziyor");
});

test("Atlas küme adresi maskelenir", () => {
  const srv = "querySrv ENOTFOUND _mongodb._tcp.ornek-kume.abc123.mongodb.net";
  const c = temizle(srv);
  assert.ok(!c.includes("mongodb.net"), "kume adresi siziyor");
  assert.ok(!c.includes("ornek-kume"), "kume adi siziyor");

  const host = "connection refused to cluster0-shard.abc.mongodb.net:27017";
  assert.ok(!temizle(host).includes("mongodb.net"));
});

test("bağlantı dizesi maskelenir", () => {
  const uri = "MongoServerError at mongodb+srv://kul:parola@kume.abc.mongodb.net/db";
  const c = temizle(uri);
  assert.ok(!c.includes("parola"), "parola siziyor");
  assert.ok(!c.includes("mongodb+srv://"), "baglanti dizesi siziyor");
});

test("zararsız mesajlar DEĞİŞMEZ", () => {
  // Aşırı temizlik hata ayıklamayı imkânsız kılar; kural dar tutuldu.
  for (const m of [
    'Cannot read properties of null (reading "x")',
    "LC_NOT_ENOUGH",
    "Expected property name or '}' in JSON at position 1",
  ]) {
    assert.equal(temizle(m), m, `zararsiz mesaj degistirilmis: ${m}`);
  }
});

test("yalnızca hata alanları temizlenir", () => {
  // ⚠️ Tüm gövdeyi taramak, oyuncu adı gibi meşru veriyi de bozardı.
  const govde = govdeyiTemizle({
    ok: false,
    error: "READ_FAILED",
    detail: "ENOENT: open /opt/render/project/src/api/data/preds.json",
    userId: "Ali",
    yol: "/opt/render/project/src/api/data/x.json",   // hata alanı DEĞİL
  });
  assert.ok(!govde.detail.includes("/opt/render"), "detail temizlenmemis");
  assert.equal(govde.userId, "Ali", "mesru alan bozulmus");
  assert.ok(govde.yol.includes("/opt/render"), "hata alani olmayan alan degistirilmis");
});

test("değişiklik yoksa aynı nesne döner (gereksiz kopya yok)", () => {
  const g = { ok: true, items: [1, 2, 3] };
  assert.equal(govdeyiTemizle(g), g);
});

test("uçtan uca: Express yanıtı temizlenmiş gelir", async () => {
  const express = require("express");
  const app = express();
  app.use(hataTemizleyici);
  app.get("/patla", (req, res) =>
    res.status(500).json({
      ok: false,
      error: "READ_FAILED",
      detail: "ENOENT: open /opt/render/project/src/api/data/preds.json",
    })
  );

  const s = app.listen(0);
  try {
    const p = s.address().port;
    const j = await fetch(`http://127.0.0.1:${p}/patla`).then((r) => r.json());
    assert.ok(!j.detail.includes("/opt/render"), "yanitta sunucu yolu siziyor");
    assert.equal(j.error, "READ_FAILED", "hata kodu korunmali");
  } finally {
    s.close();
  }
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: temizleyici rota montajlarından ÖNCE bağlı", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8");
  const i = src.indexOf("hataTemizleyici");
  assert.ok(i > 0, "temizleyici server.cjs'e baglanmamis");

  const ilkMontaj = src.search(/app\.use\(\s*"\/api/);
  assert.ok(ilkMontaj > 0, "api montaji bulunamadi");
  assert.ok(i < ilkMontaj, "temizleyici ilk /api montajindan SONRA — o rotalar korunmaz");
});
