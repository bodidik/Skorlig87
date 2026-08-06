"use strict";

/**
 * EKONOMİ SABİTLERİ — TEK KAYNAK.
 *
 * ⚠️ NEDEN VAR: açılış bakiyesi DÖRT dosyada, İKİ AYRI ADLA tanımlıydı:
 *
 *     routes/settle2.cjs    const LC_START = 30;
 *     routes/users.cjs      const LC_START = 30;
 *     routes/lc-wallet.cjs  const INITIAL_DEFAULT = 30;
 *     routes/pred.cjs       const INITIAL_DEFAULT = 30;
 *
 * Değerler bugün uyuşuyor, ama bu bir tesadüf: birini değiştiren kişi
 * diğerini ARAMAZ, çünkü adı farklı. O anda kullanıcının açılış bakiyesi
 * cüzdanını HANGİ KOD YOLUNUN oluşturduğuna bağlı hale gelir —
 * `users.cjs` profili önce yazarsa 30, settle sırasında oluşursa başka.
 * Böyle bir sapma hata üretmez, yalnızca oyuncular arasında adaletsizlik
 * yaratır ve fark edilmesi çok zordur.
 *
 * Dosyalardaki yorumlar zaten "pred.cjs ve settle2.cjs ile SENKRON tutulmalı"
 * diyordu. Elle senkron gerektiren her sabit, sapmayı bekleyen bir hatadır.
 *
 * ⚠️ Yeni bir ekonomi sabiti eklerken BURAYA ekle; tests/ekonomi-sabitleri
 * testi dosyalarda yeniden tanımlanmadığını denetliyor.
 */

/** Yeni kullanıcının açılış bakiyesi (LC). */
const ACILIS_BAKIYESI = Number(process.env.SKORLIG_INITIAL_DEFAULT || 30);

/**
 * 1987GS üyesinin açılış bakiyesi — artık normalle AYNI.
 * Fark bonus1987 alanında: 30 balance + 30 bonus1987 = 60 erişilebilir LC.
 * bonus1987 yalnızca 1987-tanımlı oyunlarda harcanır.
 */
const ACILIS_BAKIYESI_1987 = Number(process.env.SKORLIG_INITIAL_1987 || 30);

/**
 * 1987GS bonus bakiyesi tavanı. Aylık tamamlama bu tavana kadar yükseltir.
 * Tüm bonus harcanınca 1987 oyunlarında da normal bakiye kullanılır.
 */
const BONUS_1987_TAVAN = Number(process.env.SKORLIG_BONUS_1987_CAP || 30);

/**
 * Bir maça tahmin göndermenin bedeli (LC).
 * ⚠️ Günlük taban bununla ilişkili: taban, günlük oyun bedelinin 3 katından
 * AZ kalmalı — yoksa her şeyini kaybeden oyuncu ertesi gün tam tamamlanır ve
 * kaybetmek bedava olur. bkz. routes/lc-wallet.cjs gunlukTaban notu.
 */
const MAC_GIRIS_BEDELI_NORMAL = Number(process.env.SKORLIG_MATCH_COST || 3);

/**
 * LANSMAN DÖNEMİ — giriş bedelleri düşük tutulur.
 * Bitiş tarihi geçince normal bedele dönülür. Kullanıcıya tarih gösterilir.
 * Format: ISO tarih string. Boşsa lansman dönemi KAPALI (normal bedel).
 */
const LANSMAN_BITIS = process.env.SKORLIG_LANSMAN_BITIS || "2026-09-30T23:59:59Z";
const LANSMAN_BEDELI = Number(process.env.SKORLIG_LANSMAN_BEDELI || 1);

function lansmanAktifMi() {
  if (!LANSMAN_BITIS) return false;
  return Date.now() < Date.parse(LANSMAN_BITIS);
}

/** Her çağrıda güncel tarih kontrolü yapar — sunucu yeniden başlatılmasa da
 *  lansman dönemi bittiğinde normal bedele döner. */
function macGirisBedeli() {
  return lansmanAktifMi() ? LANSMAN_BEDELI : MAC_GIRIS_BEDELI_NORMAL;
}
const MAC_GIRIS_BEDELI = MAC_GIRIS_BEDELI_NORMAL;

/**
 * TAHMİN KİLİDİ — başlamasına kaç dakika kala tahmin kapanır.
 *
 * ⚠️ İKİ FARKLI DEĞER VARDI VE KULLANICIYA YALAN SÖYLÜYORDUK:
 *     routes/pred.cjs   PRED_LOCK_BEFORE_MIN = 10   ← GERÇEKTE UYGULANAN
 *     routes/live2.cjs  LOCK_BEFORE_MIN      =  5   ← listede gösterilen
 *     routes/fixtures.cjs LOCK_BEFORE_MIN    =  5
 *     routes/duels.cjs  DUEL_LOCK_BEFORE_MIN = 10
 *
 * SONUCU: kickoff'a 10–5 dakika kalan aralıkta maç listede AÇIK görünüyor
 * (`lock: false`), kullanıcı tahminini giriyor, gönderince sunucu
 * `PRED_LOCKED_BEFORE_KICKOFF` ile REDDEDİYOR. Her maç bu 5 dakikalık
 * pencereden geçiyor.
 *
 * Daha kötüsü: `/live2/open` yanıtı `lockBeforeMin: 5` alanını da
 * döndürüyordu ve mobil bunu doğrudan ekrana yazıyor ("Kilit: 5 dk",
 * app/(tabs)/live.tsx:1194) — yani uygulama kullanıcıya YANLIŞ KURALI
 * bildiriyordu.
 *
 * ⚠️ DOĞRU DEĞER 10, ÇÜNKÜ UYGULANAN O. Listeyi 10'a çekmek maçı 5 dakika
 * ERKEN kilitli gösterir; tersi ise çalışmayan bir buton demek. Bu yönde
 * yanılmak ucuz, öbür yönde yanılmak kırık bir eylem.
 */
const TAHMIN_KILIT_DK = Number(process.env.SKORLIG_PRED_LOCK_MIN || 10);

/**
 * MAÇ ÖDÜLÜ — kazanılan `base` puandan LC'ye.
 *
 * ⚠️ TEK KAYNAK OLMAK ZORUNDA. Bu merdiven `routes/settle2.cjs` içinde yerel
 * bir fonksiyondu (`computeLcRewardFromDetail`) ve ödemeyi O belirliyor. Ama
 * `routes/daily-picks.cjs` kullanıcıya gösterdiği ödülü BAMBAŞKA bir formülle
 * hesaplıyordu: `Math.round(10 * ham_oran)`.
 *
 * ÖLÇÜLDÜ — ekranda yazan ile cüzdana geçen:
 *     Galatasaray–Fenerbahçe (dep)  vaat  38 LC · ödenen ≤15  (2.5 kat)
 *     Beşiktaş–Trabzonspor  (dep)  vaat  51 LC · ödenen ≤15  (3.4 kat)
 *     Real Madrid–Erokspor  (dep)  vaat 3009 LC · ödenen ≤15  (200 kat)
 *
 * Sebep: puanlama ham oranı [0.34, 4.0] aralığına SIKIŞTIRIYOR
 * (`services/match-weights.cjs` oddsMultiplier), gösterim ise sıkıştırmıyordu.
 * Yani ekran para konusunda yanlış söz veriyordu.
 *
 * Artık ödeme de gösterim de bu fonksiyondan geçiyor.
 */
function macOdulu(base) {
  const b = Number(base) || 0;
  if (b >= 30) return 15;  // usta: skor + yan kalemler
  if (b >= 20) return 10;  // çok iyi
  if (b >= 12) return  7;  // underdog outcome veya iyi paket
  if (b >=  6) return  4;  // mid-tier + yan kalem
  if (b >=  3) return  2;  // favori outcome doğru
  if (b >   0) return  1;  // bir şey bilmiş
  return 0;
}

/** Yalnızca sonucu doğru bilen bir tahminin `base` puanı (yan kalem yok). */
const SONUC_TABAN_PUAN = 3;

/**
 * GÜNLÜK LC TABANI — "hibe" değil, TAMAMLAMA.
 *
 * ⚠️ AYNI ORTAM DEĞİŞKENİ İKİ YERDE FARKLI VARSAYILANLA OKUNUYORDU:
 *     routes/lc-wallet.cjs : SKORLIG_DAILY_FLOOR || 3   <- ÖDEMEYİ BU YAPIYOR
 *     lib/premium.cjs      : SKORLIG_DAILY_FLOOR || 6   <- SATIŞ EKRANI BUNU GÖSTERİYORDU
 * Değişken set edilmezse ikisi 2 KAT ayrışıyor; set edilirse tesadüfen
 * uyuşuyor. Yani hata yalnızca varsayılan yapılandırmada, üretimde,
 * kullanıcının gördüğü yerde ortaya çıkıyordu.
 *
 * ⚠️ TAMAMLAMA OLDUĞU BURADA YAZILI KALMALI: bakiye tabanın ÜSTÜNDEYSE
 * verilen 0'dır. Ekranda "her gün 12 LC" gibi sunulursa yanlış vaat olur —
 * bu tam olarak lc-wallet.cjs'in bir kez düzelttiği hata (bkz. gunlukMiktar).
 */
const GUNLUK_TABAN       = Number(process.env.SKORLIG_DAILY_FLOOR || 3);
const GUNLUK_TABAN_SERI3 = Number(process.env.SKORLIG_DAILY_FLOOR_STREAK3 || 5);
const GUNLUK_TABAN_SERI7 = Number(process.env.SKORLIG_DAILY_FLOOR_STREAK7 || 7);
const GUNLUK_TABAN_PREM  = Number(process.env.SKORLIG_DAILY_FLOOR_PREMIUM || 12);

module.exports = {
  GUNLUK_TABAN,
  GUNLUK_TABAN_SERI3,
  GUNLUK_TABAN_SERI7,
  GUNLUK_TABAN_PREM,
  ACILIS_BAKIYESI,
  ACILIS_BAKIYESI_1987,
  BONUS_1987_TAVAN,
  MAC_GIRIS_BEDELI,
  MAC_GIRIS_BEDELI_NORMAL,
  macGirisBedeli,
  LANSMAN_BITIS,
  LANSMAN_BEDELI,
  lansmanAktifMi,
  TAHMIN_KILIT_DK,
  macOdulu,
  SONUC_TABAN_PUAN,
  // Eski adlar — geçiş sırasında çağıranlar bozulmasın diye.
  LC_START: ACILIS_BAKIYESI,
  INITIAL_DEFAULT: ACILIS_BAKIYESI,
  INITIAL_1987: ACILIS_BAKIYESI_1987,
  LC_MATCH_COST: MAC_GIRIS_BEDELI,
};
