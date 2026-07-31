"use strict";

/**
 * ÜRETİM SİNYALİ — tek kaynak.
 *
 * ⚠️ NEDEN AYRI DOSYA: bu koşul `server.cjs` içinde yerel bir sabitti
 * (`URETIM_SINYALI`) ve CORS politikasını belirliyordu. `verifyToken` de aynı
 * ayrımı yapmak zorunda (dev geri düşüşü üretimde ASLA çalışmamalı). İkinci
 * bir kopya yazmak, bu oturumda tekrar tekrar hata üreten desendi: kopyalar
 * bir yerde güncellenip ötekinde unutuluyor ve ayrışma sessiz oluyor.
 *
 * ⚠️ `RENDER` DE OKUNUYOR: `NODE_ENV` üretimde ayarlanmamış olabiliyor —
 * `.env.example`'a sonradan eklendi. Render kendi ortamında `RENDER=true` set
 * eder, yani NODE_ENV unutulsa bile üretim tanınır. Güvenlik kararını TEK bir
 * elle-ayarlanan değişkene bağlamak, o değişken unutulduğunda sessizce gevşek
 * moda düşmek demektir.
 */
function uretimMi() {
  return (
    process.env.NODE_ENV === "production" ||
    String(process.env.RENDER || "") === "true"
  );
}

module.exports = { uretimMi };
