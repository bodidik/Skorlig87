# Production Geçiş Kılavuzu

İki iş var ve **bağımsızdırlar** — ayrı ayrı, farklı günlerde yapılabilir:

- **A. MongoDB migration** (tahminler dosyadan Mongo'ya) — geri alması zor, dikkatli sırayla
- **B. Redis** (hız sınırı sayacı) — düşük riskli, istediğin zaman

> Buradaki komutlar `api/` dizininden çalıştırılır.

---

## A. MongoDB migration

Bugün tahminler hem `data/preds.json`'a hem MongoDB'ye yazılıyor (ayna modu).
Amaç: aynayı kapatıp Mongo'yu tek kaynak yapmak.

**Neden dikkat:** `SKORLIG_PREDS_FILE_MIRROR=0` yapıldığı anda `preds.json` artık
yazılmaz. Migration eksikse bu fark edilmeyen kalıcı veri kaybına döner.
Bu yüzden bayrak, doğrulama "GO" demeden çevrilmez.

### A1. Yedek al (production dosyası)

Migration'ı geri almanın tek yolu bu yedek. Render'da Shell'den:

```bash
cp data/preds.json data/preds.backup-$(date +%Y%m%d-%H%M%S).json
```

### A2. Ortam değişkenlerini doğrula

```bash
node -e "console.log('URI var mi:', !!process.env.MONGODB_URI, '| DB:', process.env.MONGODB_DB||'skorlig')"
```

⚠️ Değişkenin adı **`MONGODB_URI`**. Eski `MONGO_URI` yalnızca geriye uyumluluk
için kabul edilir; yeni kurulumda `MONGODB_URI` kullan.

### A3. Migration'ı çalıştır

İdempotenttir — yarıda kalırsa tekrar çalıştırılabilir, mevcut kayıtlar `$set`
ile güncellenir, çift kayıt oluşmaz.

```bash
node scripts/migrate-preds-to-mongo.cjs
```

Beklenen son satır: `[migrate] Tamamlandı. <N> tahmin MongoDB'ye aktarıldı.`

### A4. Doğrula — bu adım atlanamaz

```bash
node scripts/verify-migration.cjs
```

Kontrol ettikleri: kayıt sayısı, zorunlu indeksler, örneklem üzerinde alan alan
karşılaştırma, bot/insan dağılımı.

- `SONUC: GO` + çıkış kodu 0 → devam et
- `SONUC: NO-GO` + çıkış kodu 1 → **bayrağı çevirme**, raporlanan eksiği gider

### A5. Aynayı kapat

Önce bir süre (birkaç gün) ayna açıkken izlemek en güvenlisi: Mongo'ya yazım
sorunsuzsa dosya zaten yedek görevi görür.

Hazır olunca Render → Environment:

```
SKORLIG_PREDS_FILE_MIRROR=0
```

Servisi yeniden başlat.

### A6. Kapattıktan sonra kontrol

```bash
# Tahmin gönderimi Mongo'ya yazıyor mu (sayı artmalı)
node -e "require('./lib/mongo.cjs').getDb().then(async d=>{console.log('predictions:', await d.collection('predictions').countDocuments());process.exit(0)})"
```

Uygulamadan bir tahmin gönder, sayının arttığını gör. `preds.json`'ın
değişmediğini de doğrula (artık yazılmıyor olmalı).

### Geri alma

`SKORLIG_PREDS_FILE_MIRROR=1` yap ve servisi yeniden başlat. Ayna kapalıyken
gelen tahminler dosyada yoktur; dosyayı A1 yedeğinden geri yüklersen o aradaki
tahminler kaybolur — Mongo'da durdukları için kayıp değil, sadece dosya eksik kalır.

---

## A2. Cüzdan dosya aynasını kapat

Ödül dağıtımı `lc-wallet.json` ve `users.json`'ı **her settle'da baştan yazar**.
Bu iki dosya kullanıcı sayısıyla doğrusal büyür ve `JSON.parse`/`stringify`
senkron olduğu için olay döngüsünü bloklar — yani sunucu o süre boyunca
hiçbir isteği işleyemez.

Ölçülen (40 tahmincili tek settle):

| cüzdan | dosya | ayna=1 | ayna=0 |
|---|---|---|---|
| 10.000 | 4.4 MB | 429 ms | 191 ms |
| 50.000 | 22 MB | 1087 ms | 205 ms |
| 100.000 | 44 MB | **2238 ms** | **267 ms** |

Ayna kapalıyken süre kullanıcı sayısından neredeyse bağımsız kalır.

### Ön koşul

Cüzdan verisinin Mongo'da olması gerekir. Ödüller `$inc` ile göreli işlendiği
için ayna kapalıyken **yeni** ödüller sorunsuz gider; ama mevcut bakiyeler
Mongo'da yoksa kullanıcılar bakiyelerini kaybolmuş görür.

```bash
# Mongo'daki cüzdan kaydı sayısı, dosyadakiyle karşılaştır
node -e "require('./lib/mongo.cjs').getDb().then(async d=>{console.log('mongo cuzdan:', await d.collection('lc_wallet_users').countDocuments());process.exit(0)})"
node -e "console.log('dosya cuzdan:', JSON.parse(require('fs').readFileSync('data/lc-wallet.json','utf8')).users.length)"
```

Sayılar yakın değilse **kapatma** — önce cüzdanı Mongo'ya taşı.

### Kapat

```
SKORLIG_WALLET_FILE_MIRROR=0
```

⚠️ `MONGODB_URI` tanımlı değilse bu bayrak **yok sayılır** ve dosya yazılmaya
devam eder — yanlışlıkla 0 yapmak veri kaybına yol açmaz (test edildi).

### Geri alma

`SKORLIG_WALLET_FILE_MIRROR=1` + yeniden başlat. Ayna kapalıyken verilen
ödüller dosyada yoktur (Mongo'da durur); dosya o aralık için eksik kalır.

---

## A3. Maç sonucu snapshot aynasını kapat

`match-results.json` her settle'da **baştan yazılıyordu**. Her kayıt maçın tüm
sıralamasını gömdüğü için dosya hızla büyür (ölçüldü: 15 kayıt / 5.3 MB,
kayıt başına ~408 KB) ve maliyet **geçmişteki maç sayısıyla** artar — yani
sistem yaşlandıkça her settle yavaşlar.

⚠️ **Eski kayıtları silerek çözme.** `awardedAt` alanı aynı zamanda çift-ödül
mührüdür ve `livescore-sync` "hangi maçlar sonuçlandı" bilgisini buradan okur.
Kayıt silinirse o maç yeniden sonuçlandırılır ve **ödüller ikinci kez dağıtılır**.

### Ön koşul

Snapshot'lar Mongo'da olmalı. `settle2` yeni settle'ları `match_results`
koleksiyonuna yazar; ayna kapatılmadan önce **geçmiş** snapshot'ların da orada
olduğundan emin ol — yoksa kullanıcıların maç geçmişi ve haftalık sıralamalar
eksik görünür.

```bash
# Mongo'daki snapshot sayısı vs dosyadaki
node -e "require('./lib/mongo.cjs').getDb().then(async d=>{console.log('mongo snapshot:', await d.collection('match_results').countDocuments());process.exit(0)})"
node -e "console.log('dosya snapshot:', JSON.parse(require('fs').readFileSync('data/match-results.json','utf8')).items.length)"
```

### Geçmişi taşı

`settle2` yalnızca YENİ settle'ları Mongo'ya yazar; eski snapshot'lar
kendiliğinden taşınmaz. Tek seferlik aktarım (idempotent, tekrar çalıştırılabilir):

```bash
node scripts/migrate-match-results.cjs
```

Aktarım bittiğinde doğrulama otomatik çalışır. Sonradan tekrar denetlemek için:

```bash
node scripts/migrate-match-results.cjs --verify
```

Kontrol ettikleri: snapshot sayısı · zorunlu indeksler · örneklemde satır sayısı
· **`awardedAt` mührü** (kaybolursa maç yeniden ödüllendirilir) · ve asıl sorgu
yolu — bir kullanıcının geçmişi Mongo'dan gerçekten dönüyor mu.

> Son madde önemli: veri doğru görünse bile `rows.userIdLower` alanı eksikse
> geçmiş sorgusu **hata vermeden boş döner**; kullanıcı geçmişini kaybetmiş
> sanır. Script bunu ayrıca sınar.

- `SONUC: GO` + çıkış kodu 0 → devam et
- `SONUC: NO-GO` + çıkış kodu 1 → **bayrağı çevirme**

### Kapat

```
SKORLIG_MATCHRESULTS_FILE_MIRROR=0
```

`MONGODB_URI` tanımlı değilse bayrak **yok sayılır**, dosya yazılmaya devam eder.

### Geri alma

`SKORLIG_MATCHRESULTS_FILE_MIRROR=1` + yeniden başlat. Ayna kapalıyken üretilen
snapshot'lar dosyada yoktur (Mongo'da durur).

---

## B. Redis (hız sınırı)

Şu an `REDIS_URL` tanımsız ve sayaç **bellekte** tutuluyor. Tek instance'ta
doğru çalışır; birden fazla instance varsa limit her instance'ta ayrı işler,
yani fiilen N katına çıkar.

### B1. Redis sağla

Render Redis ya da Upstash. Ücretsiz kademeler bu iş için yeterli — hız sınırı
sayaçları küçük ve TTL'li.

### B2. Ortam değişkeni

Render → Environment:

```
REDIS_URL=rediss://default:PAROLA@host:port
```

Kod değişikliği gerekmez; `REDIS_URL` görülünce Redis moduna geçilir.

### B3. Doğrula

⚠️ Render ücretsiz katmanda **Shell yok**; doğrulama HTTP ucundan yapılır:

```bash
curl -s "https://<host>/api/admin/rate-store?probe=1" -H "x-admin-token: $SKORLIG_ADMIN_TOKEN"
```

`verdict: "REDIS AKTIF"` görmelisin (HTTP 200).

`?probe=1` gerçek bir sayaç yazar. Bu şart: `hit()` arıza durumunda **hata
fırlatmaz** (fail-open), dolayısıyla "hata gelmedi" Redis'in çalıştığını
göstermez. Asıl kanıt `probe.counted: true` — sayacın gerçekten artmış olması.

`REDIS_URL` tanımlıyken uç **HTTP 503** dönerse bağlantı kurulamıyor ve sessizce
bellek moduna düşülmüş demektir; harici izleme aracına bu kodu bağlamak işe yarar.

**Arıza duruşu:** Redis düşerse istekler **engellenmez** (fail-open). Hız sınırı
bir koruma katmanıdır; Redis kesintisinin tüm API'yi kapatması daha kötü olurdu.

---

## Geçiş sonrası sağlık kontrolü

```bash
curl -s https://<host>/api/admin/scraper-health -H "x-admin-token: $SKORLIG_ADMIN_TOKEN"
```

`status` alanı `ok` olmalı. `critical` durumunda uç HTTP 503 döner — harici
izleme aracına bunu bağlamak işe yarar.
