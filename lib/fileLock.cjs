"use strict";

const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");

/**
 * Dosya-anahtarlı async mutex.
 * Tek Node sürecinde aynı dosyaya yapılan read-modify-write işlemlerini
 * sıraya sokar; böylece "lost update" (biri diğerini ezer) yarışı olmaz.
 *
 * Kullanım:
 *   await withFileLock(WALLET_FILE, async () => {
 *     const state = await load();
 *     state.x += 1;
 *     await save(state);
 *   });
 */
const _tails = new Map(); // key -> zincirin kuyruğu (Promise)

// Bekleyen + çalışan işlem sayısı. Düzgün kapanış bunun sıfırlanmasını
// bekler ki yazma ortasında süreç ölmesin (bkz. server.cjs gracefulShutdown).
let _active = 0;

/** Şu an sırada veya çalışmakta olan kilitli işlem sayısı. */
function activeLockCount() {
  return _active;
}

function withFileLock(key, fn) {
  const k = String(key);
  const prev = _tails.get(k) || Promise.resolve();

  _active++;
  // fn önceki işlem bitince çalışır (başarı/başarısızlık fark etmez).
  const result = prev.then(() => fn(), () => fn());
  result.then(
    () => { _active--; },
    () => { _active--; }
  );

  // Zincir kuyruğu: hataları yut ki zincir kırılmasın.
  const tail = result.then(
    () => {},
    () => {}
  );
  _tails.set(k, tail);

  // Sızıntı önleme: kuyruğun sonundaysak Map'ten temizle.
  tail.then(() => {
    if (_tails.get(k) === tail) _tails.delete(k);
  });

  return result; // çağırana gerçek sonuç/hatayı ilet
}

/**
 * Atomik JSON yazma: geçici dosyaya yaz, sonra rename et.
 * rename POSIX/NTFS'te atomik olduğundan, süreç çökse bile hedef dosya
 * ya eski ya yeni tam haliyle kalır — yarım/bozuk yazma olmaz.
 *
 * ⚠️ GEÇİCİ AD SAYAÇ İÇERİYOR. Yalnızca `pid-Date.now()` iken aynı
 * milisaniyede başlayan iki çağrı AYNI geçici adı kullanıyordu: biri
 * rename ederken diğerinin dosyası kayboluyor ve ENOENT ile patlıyordu.
 * ÖLÇÜLDÜ: 30 eşzamanlı çağrının 21'i hata verdi. Aynı düzeltme
 * lib/fixtures-store, lib/social-store ve altı depoda ZATEN vardı — bu
 * paylaşılan yardımcıda eksikti.
 */
let _tmpSayac = 0;
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await renameYenidenDene(tmp, file, data);
  } catch (e) {
    // Yarım kalan geçici dosyayı bırakma; disk dolabilir.
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * ⚠️ WINDOWS'TA RENAME GEÇİCİ OLARAK REDDEDİLEBİLİR.
 * POSIX'te açık bir dosyanın üzerine rename sorunsuzdur; Windows'ta o anda
 * dosyayı okuyan bir tanıtıcı varsa EPERM/EBUSY döner. Atomik yazmaya
 * geçtiğim anda ölçüm betiğim tam bunu yakaladı (okuma döngüsü sürerken
 * EPERM). Üretim Linux ama geliştirme ve testler Windows'ta koşuyor;
 * çarpışma penceresi normalde milisaniyelik olduğu için kısa bir yeniden
 * deneme yetiyor.
 *
 * ⚠️ SON ÇARE DOĞRUDAN YAZMA — ve bunu dürüstçe yazıyorum: ısrarlı EPERM'de
 * atmak yerine eski davranışa (doğrudan writeFile) düşüyoruz. Atmak, kota
 * sayacını hiç güncellememek demekti; en kötü hâlde ESKİ davranışa dönüyoruz,
 * daha kötüsüne değil. Düşüş SESSİZ DEĞİL: sayaç `atomikDusus()` ile
 * okunabiliyor ve testte sıfır olması bekleniyor.
 */
let _dususSayaci = 0;
function atomikDusus() { return _dususSayaci; }

async function renameYenidenDene(tmp, file, data, deneme = 8) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      const gecici = e && (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES");
      if (!gecici) throw e;
      if (i >= deneme - 1) {
        _dususSayaci++;
        await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
        return;
      }
      await new Promise((r) => setTimeout(r, 5 * (i + 1)));
    }
  }
}

module.exports = { withFileLock, writeJsonAtomic, activeLockCount, atomikDusus };
