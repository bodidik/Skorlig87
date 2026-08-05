"use strict";

/**
 * ATOMİK YAZMADAN ARTAN GEÇİCİ DOSYALARI SÜPÜRÜR.
 *
 * ⚠️ NEDEN VAR — ÖLÇÜLDÜ (2026-08-05, geliştirme makinesi): `data/` altında
 * 39 artık dosya, toplam 38,4 MB. En eskisi 17 Temmuz, yani üç haftada
 * birikmiş.
 *
 * Kaynak: bu depodaki sekiz depo modülü de aynı atomik yazma desenini
 * kullanıyor — geçici dosyaya yaz, sonra `rename` ile yerine koy
 * (lib/fileLock.cjs, fixtures-store, push-store, social-store,
 * settings-store, streak-store, invite-store, moderation-store). Hepsinde
 * `catch` içinde `unlink` var, yani YAZMA HATASINDA temizlik yapılıyor.
 *
 * Ama süreç `rename`den ÖNCE ölürse `catch` hiç çalışmaz: SIGKILL, çökme,
 * deploy kesintisi, elektrik. Geçici dosya diskte kalır ve kimse toplamaz.
 * Sekiz kopyanın hiçbirinde bayat dosya temizliği yoktu.
 *
 * ⚠️ TEK YERDE: aynı kuralı sekiz modüle yazmak, bu depoda defalarca
 * ayrışmaya yol açan desendir (bkz. mobil yol ve node_modules yolu). Süpürme
 * açılışta BİR KEZ, dizin bazında yapılıyor — her yazma yolunun ayrı ayrı
 * bilmesi gerekmiyor.
 *
 * ⚠️ YAŞ EŞİĞİ ŞART — YOKSA CANLI YAZMAYI BOZAR. Aynı dizine yazan başka bir
 * süreç olabilir (üretimde tek süreç, ama geliştirmede sunucu + test + script
 * yan yana koşuyor). Onun O AN yazdığı geçici dosyayı silmek, yarım veriyi
 * `rename` ettirir ya da yazmayı patlatır. Gerçek bir yazma milisaniyeler
 * sürüyor; 1 saatlik eşik hiçbir canlı yazmaya denk gelmez.
 *
 * ⚠️ KALIP DAR: yalnızca `<ad>.tmp-<pid>-<zaman>-<sayac>` biçimi siliniyor.
 * Kullanıcının `.tmp` uzantılı meşru bir dosyası varsa dokunulmuyor.
 */

const fs = require("fs");
const path = require("path");

/**
 * Atomik yazma geçici dosyası: `x.json.tmp-<pid>-<zaman>` ya da
 * `x.json.tmp-<pid>-<zaman>-<sayac>`.
 *
 * ⚠️ SAYAÇ NEDEN İSTEĞE BAĞLI: bugünkü kod üç parça üretiyor
 * (`${pid}-${Date.now()}-${++sayac}`) ama diskteki artıkların ÇOĞU eski
 * iki parçalı adlandırmadan kalma. Kalıbı üç parçayla sınırlı yazmıştım;
 * gerçek dizinde kuru koşu yapınca yakalandı:
 *
 *     kalıba uyan      33 dosya   4,9 MB
 *     kalıp dışı        6 dosya  33,6 MB   ← üçü 11 MB'lık preds.json
 *
 * Yani dar kalıp çöpün %87'sini bırakıyordu. Süpürme, temizlemesi gereken
 * şeyin çoğunu görmezse hiç yokmuş gibidir.
 *
 * ⚠️ YİNE DE DAR: `.tmp` uzantılı meşru dosyalar, `x.json.tmp-abc` ya da
 * tek parçalı `x.json.tmp-1` eşleşmez.
 */
const KALIP = /\.tmp-\d+-\d+(?:-\d+)?$/;

/** 1 saatten eski artıklar süpürülür (canlı yazma penceresi milisaniye). */
const VARSAYILAN_YAS_MS = 60 * 60 * 1000;

/**
 * @param {string} dizin taranacak dizin
 * @param {{yasMs?:number}} [secenek]
 * @returns {Promise<{silinen:number, bayt:number, hata:number}>}
 */
async function bayatTmpTemizle(dizin, secenek) {
  const yasMs = Number(secenek?.yasMs ?? VARSAYILAN_YAS_MS);
  const sonuc = { silinen: 0, bayt: 0, hata: 0 };
  if (!dizin) return sonuc;

  let girdiler;
  try {
    girdiler = await fs.promises.readdir(dizin, { withFileTypes: true });
  } catch {
    return sonuc; // dizin yok — yapacak bir şey yok
  }

  const simdi = Date.now();
  for (const g of girdiler) {
    if (!g.isFile() || !KALIP.test(g.name)) continue;
    const tam = path.join(dizin, g.name);
    try {
      const st = await fs.promises.stat(tam);
      if (simdi - st.mtimeMs < yasMs) continue; // taze — başka süreç yazıyor olabilir
      await fs.promises.unlink(tam);
      sonuc.silinen++;
      sonuc.bayt += st.size;
    } catch {
      /* Yarışta başkası silmiş ya da kilitli olabilir; bir sonraki açılışta
       * yine denenecek. Süpürme en iyi çaba, kritik yol değil. */
      sonuc.hata++;
    }
  }
  return sonuc;
}

module.exports = { bayatTmpTemizle, _KALIP: KALIP, _VARSAYILAN_YAS_MS: VARSAYILAN_YAS_MS };
