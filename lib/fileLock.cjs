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

function withFileLock(key, fn) {
  const k = String(key);
  const prev = _tails.get(k) || Promise.resolve();

  // fn önceki işlem bitince çalışır (başarı/başarısızlık fark etmez).
  const result = prev.then(() => fn(), () => fn());

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
 */
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

module.exports = { withFileLock, writeJsonAtomic };
