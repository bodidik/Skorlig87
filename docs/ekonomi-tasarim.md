# SkorLig Ekonomisi — Tasarım

**Durum:** Taslak, onay bekliyor. Kod yazılmadı.
**Tarih:** 2026-07-29
**Kapsam:** LC arzı · puan sıralaması · maç havuzu

---

## Özet

Üç şey aynı anda tasarlanmalı çünkü birbirini besliyorlar:

1. **LC arzı** bugün kontrolsüz — ölçüldü: giriş/çıkış oranı **145:1**, oyuncuların **%100'ü** her maçta kâr ediyor
2. **Puan sıralaması** kümülatif — kıdemi ödüllendiriyor, beceriyi değil
3. **Havuz** yeni bir para mekaniği — bozuk bir ekonomiye eklenirse bozukluğu büyütür

Aşağıdaki her sayı ölçümden geliyor, tahminden değil.

---

## Bölüm 1 — Mevcut durum (ölçüm)

### LC arzı · 838 cüzdan

| | |
|---|---|
| Medyan bakiye | **2 LC** |
| En yüksek | 229 LC |
| Toplam arz | 2.167 LC |
| Toplam giriş | 2.182 LC |
| Toplam çıkış | **15 LC** |

Giriş kalemleri: maç ödülü 1.852 · erken kullanıcı 200 · başlangıç 120 · günlük 10
Çıkış kalemi: maç girişi **15**

> Tek gider kalemi fiilen çalışmıyor. Para yaratılıyor, hiçbir yere akmıyor.

### Maç başına net LC — asıl delik

Kurallar: giriş **3 LC**, `base > 0` ise iade **3 LC**, üstüne kademeli ödül.

| base | ödül | iade | **net** |
|---|---|---|---|
| 0 | 0 | 0 | **−3** |
| 1 | 1 | 3 | **+1** |
| 3 | 2 | 3 | **+2** ← medyan oyuncu |
| 6 | 4 | 3 | **+4** |
| 12 | 7 | 3 | **+7** |
| 30 | 15 | 3 | **+15** |

**Sorun iadenin eşiğinde.** `base > 0` yeterli olduğu için "kıl payı bildim" bile
kârlı. Kullanıcı yalnızca **tamamen** yanıldığında kaybediyor.

1291 gerçek oyuncunun performansıyla simülasyon:

| Kural | Ortalama net | Kâr eden | Zarar eden |
|---|---|---|---|
| **Mevcut** (iade base>0) | **+2.21** | **%100** | %0 |
| iade base≥6 | −0.23 | %19 | %81 |
| iade base≥12 | −0.78 | %19 | %81 |
| iade yok | −0.78 | %19 | %81 |

### Günlük hak — ikinci delik

| Senaryo | Aylık net |
|---|---|
| Günde 1 maç + 5 LC günlük (mevcut) | **+143 LC** |
| Günde 3 maç + 5 LC günlük | **+130 LC** |
| Günde 1 maç + günlük yok | −7 LC |

Günlük hak koşulsuz eklendiği için oynamayan da biriktiriyor.

### Puan · 1583 oyuncu

| | |
|---|---|
| Medyan | 56 · max 167 · min −4 |
| İlk 10'un payı | %1.7 |
| **Maç başına puan** | medyan **4.0** · aralık −0.75 … 14.5 |
| `totalPenalty` kullanan | **0 / 1583** |

Kopuş **henüz yok** çünkü herkes ~16 maç oynamış. Sorun ilerde: kümülatif
sıralamada 6 ay oynayan, 1 hafta oynayanın önüne kıdemle geçer.

`totalPenalty` alanı var ama hiç işlemiyor — ceza altyapısı hazır, kullanılmıyor.

---

## Bölüm 2 — LC arzı düzeltmesi

### 2.1 İade eşiği: `base > 0` → `base >= 6`

Tek satırlık değişiklik, en büyük etki. Ortalama net **+2.21 → −0.23**.

Gerekçe: iade "oynadığın bedeli hak ettin" demek olmalı, "bir şey bildin"
değil. `base >= 6` gerçek bir isabet eşiği (sonuç + en az bir yan kalem).

**%81 zarar ediyor** rakamı sert görünüyor ama tahmin oyununda normaldir —
tahminlerin çoğu yanlıştır. Denge günlük hakla kuruluyor (aşağıda).

### 2.2 Günlük hak: ekleme → **tabana tamamlama**

```
Mevcut : bakiye += 5
Öneri  : bakiye < TABAN ise bakiye = TABAN     (TABAN = 15 LC)
```

- Zengin oyuncuya **0** verir → birikim kanalı kapanır
- Parasız oyuncuya can suyu → oyundan kopmaz
- Arz, oyuncu sayısıyla sınırlı kalır (sonsuz birikmez)

Premium'un günlük 10 LC hakkı da aynı mantıkla tabanı yükseltmeli (örn. 30),
koşulsuz eklememeli.

### 2.3 Yeni gider kalemleri

| Kalem | Miktar | Not |
|---|---|---|
| Havuz kesintisi | %5 | **yakılır** (karar verildi) |
| Düello kesintisi | %5 | mevcut, yakılmalı |
| Turnuva girişi | 5 LC | mini turnuva şu an ücretsiz |

### 2.4 Premium'un 300 LC'si

Aylık 300 LC, medyan bakiyenin **150 katı**. Ödemeli olduğu için gelir tarafı
sağlıklı ama ekonomiye tek kalemde büyük para basıyor.

Öneri: miktarı düşürüp ayrıcalığı **oynanabilirliğe** kaydırmak — daha yüksek
günlük taban, giriş bedeli indirimi, mağaza bonusu. Para basmak yerine erişim
satmak.

> Bu bir ürün/gelir kararı, teknik değil. Karar sizin.

### 2.5 İzleme

Arz kontrolsüz büyüyorsa erken görülmeli. Yönetim ucu (`/api/admin/economy`):

- Toplam LC arzı, medyan/ortalama bakiye
- Son 24s/7g giriş-çıkış, kalem kalem
- Net akış (+/−) ve 30 günlük eğilim

Bu uç olmadan denge ayarları körlemesine yapılır — bugünkü 145:1 oranı da
ancak elle ölçünce görüldü.

---

## Bölüm 3 — Puan sıralaması

### 3.1 Kümülatif → maç başına ortalama

**Sorun:** Toplam puanla sıralamak kıdemi ödüllendirir. 6 ay oynayan 3000
puana çıkar, yeni gelen asla yetişemez — oyun ölür.

**Çözüm:** Sıralama **maç başına ortalama puan** ile yapılır.

Veri bunu destekliyor: maç başına puan medyanı **4.0**, aralık **−0.75 … 14.5**.
Kıdemden bağımsız, gerçek bir beceri ölçüsü.

**Eşik: en az 10 maç.** Yoksa tek maçta 14.5 alan zirveye çıkar. Eşiğin altındaki
oyuncu listede "henüz sıralanmadı" olarak görünür — cezalandırma değil, sabır.

Bu tam olarak istenen sonucu verir:

- Kötü tahminci **negatife** düşer, kıdem kurtarmaz
- **0 civarı anlam kazanır** — ortalama 0 olan ortalarda yer alır
- Yeni gelen **ilk haftadan** yarışabilir

### 3.2 Sezon

Aylık (ya da üç aylık) sıfırlama + geçmiş sezon arşivi.

- Tazelik: her sezon herkes eşit başlar
- Anlatı: "bu sezon 3.'yüm"
- Bayat zirveyi temizler

Sezon bitiminde ilk N oyuncuya rozet/LC ödülü — ama ödül **arz dengesine**
uygun olmalı (bkz. 2.3).

### 3.3 Ceza mekaniği

`totalPenalty` alanı var, hiç kullanılmıyor. Ortalama tabanlı sıralamada ceza
doğal olarak çalışır: yanlış tahmin negatif puan getirir, ortalamayı düşürür.

Ek ceza kuralı gerekli mi, veri geldikçe bakılmalı. Şu an spekülasyon olur.

### 3.4 Havuz sıralamayı etkilemez

**Karar verildi.** Puan = beceri, LC = para. İkisi ayrı dünya.

Gerekçe: havuz kazancını sıralamaya katmak, çok parası olanı otomatik üste
taşır — tam da kaçınmak istediğiniz "zenginler sınıfı".

---

## Bölüm 4 — Maç havuzu

### 4.1 Neden

Düellonun sorunu: **odds kimin kazandığını belirliyor, ödemeyi belirlemiyor.**
Sürpriz sonucu bilmekle favoriyi bilmek aynı parayı kazandırıyor (1.9× sabit).

Havuz bu bağı kurar ve uygulamanın zaten var olan fikridir — onboarding metni
*"az kişinin tuttuğunu bilirsen daha fazla puan"* diyor. İlke puanlamada var,
parada yok.

### 4.2 Üç mod, üç amaç

| Mod | Amaç | Para | Girdi |
|---|---|---|---|
| **Tahmin** | Puan / sıralama | 3 LC giriş | Skor, ilk gol, kart… |
| **Havuz** | Para oyunu | Serbest bahis | Yalnızca **Ev/Beraberlik/Deplasman** |
| **Düello** | Kişisel meydan okuma | Bahis (1v1) | Tahmin puanı üzerinden |

Havuz bahsi tahminden **bağımsızdır** — para oynamak isteyeni 6 alanlık forma
zorlamak katılımı düşürür.

### 4.3 Çekirdek mekanik

```
Çarpan  = (toplam havuz − kesinti) / kazanan tarafın toplam bahsi
Kazanç  = kendi bahsi × çarpan
```

**Örnek:** Ev 400 · Beraberlik 700 · Deplasman 1900 LC → havuz 3000, kesinti %5.

- Beraberlik tutarsa: 2850 / 700 = **4.07×**
- Deplasman tutarsa: 2850 / 1900 = **1.5×**

Kalabalıkla gitmek az kazandırır — mekaniğin kendisi bu.

### 4.4 Kesinti

**%5, yakılır.** (Karar verildi.) Yalnızca kaybeden taraf varsa alınır; herkes
bildiyse kesinti yok, herkes bahsini geri alır.

### 4.5 Bahis tavanı — **açık soru**

Sabit tavan (100 LC) keyfi: *"adam 120 kazanması gerekiyor, biz 100 mü
diyeceğiz?"* Tavan yok ise tek kişi çarpanı domine eder.

**Önerim: `max(20 LC, havuzun %25'i)`**

- Kendiliğinden ölçeklenir, keyfi sayı yok
- Tek kişi çarpanı bozamaz
- Zenginin parası ancak başkaları da oynarsa işe yarar

> **Ama asıl not:** Bahis tavanı eşitsizliği önlemez, **gider önler**. Bugün
> medyan bakiye 2 LC — 100 LC tavanı kimseyi ilgilendirmiyor. Bölüm 2'deki
> düzeltmeler yapılmazsa tavan ne olursa olsun birikim sürer.

### 4.6 Botlar — kritik ayrım

> **Botlar dağılımı oluşturur, parayı oluşturmaz.**

Sistemde 1750 tahminci var ve botlar gerçekçi isimler kullanıyor (TanjuColak,
GSAslan). Havuza para ile sokmak iki kötü sonuçtan birini üretir:

- Bot kazanır → gerçek kullanıcının parası sistemden çıkar
- Bot parası dağıtılır → LC enflasyonu

Bu yüzden: ekranda dağılım **bot + insan** (bilgi sinyali), havuzdaki para
**yalnızca gerçek kullanıcı**. Tespit `lib/botIds.cjs` → `BOT_PROFILE_MAP`
üzerinden (kimlik önekiyle değil — botlar `bot_` öneki kullanmıyor).

**Arayüz ayrımı göstermeli**, yoksa "158 kişi oynadı ama havuz 60 LC" hata
sanılır. İki satır: *"Tahmin dağılımı: 20/38/98"* ve *"Havuz: 60 LC (4 oyuncu)"*.

### 4.7 Dağılım canlı gösterilir

**Karar verildi.** Sürü davranışı oyunun konusu — kalabalığa gitmenin bedeli
düşük çarpan. Bu bir kusur değil, mekanik.

### 4.8 Pencere ve iade

- **Açılış:** maçtan 96 saat önce · **Kapanış:** başlamadan 5 dk önce
- Bahis **değiştirilemez/iptal edilemez** — son dakikada kalabalığı görüp taraf
  değiştirmek çarpan mekaniğini bozar

**Tam iade** (kesintisiz): maç iptal · kazanan taraf boş · kaybeden taraf boş ·
3'ten az gerçek oyuncu.

### 4.9 Veri modeli

**Dosya yedeği yok, doğrudan Mongo.** Bugün düellolar tam bu yüzden deploy'da
kayboluyordu — Render'da kalıcı disk yok ve para verisi dosyada tutulamaz.

`match_pools`: fixtureId (benzersiz) · status · opensAt/closesAt · totals{H,D,A}
· houseCut · outcome · **settledAt (çift ödeme mührü)**

`pool_bets`: id · fixtureId · userId + **userIdLower** (indeks) · outcome ·
stake · payout · settledAt

`userIdLower` şart: tam eşleşme sorgusu karışık harfli Firebase kimlikleriyle
**hata vermeden boş dönüyor** (bu projede birkaç kez yaşandı).

### 4.10 Settle akışı

1. `settledAt` doluysa **hiçbir şey yapma** — idempotent
2. Havuzu kilitle
3. İade koşulu varsa iade et, bitir
4. Çarpanı hesapla, **`lib/wallet-credit.cjs` ile** öde
5. Bahislere `payout` + `settledAt`
6. Havuza `settledAt`

**Sıra kritik:** mühür en sonda yazılır; süreç ortada ölürse tekrar
çalıştırıldığında çift ödeme olur. Bu projede `awardedAt` mührü tam bu iş için
var, aynı desen izlenmeli.

Ödeme mutlaka `creditLc` üzerinden — mini turnuva ve TR-Lig ödülleri kendi
dosya yazımlarını yaptıkları için kullanıcının bakiyesine hiç ulaşmıyordu.

---

## Bölüm 5 — Uygulama sırası

Bağımlılık zinciri: ekonomi düzeltilmeden havuz eklemek bozukluğu büyütür.

| # | İş | Boyut | Neden bu sırada |
|---|---|---|---|
| 1 | İade eşiği + günlük taban | küçük | En büyük etki, tek satırlık değişiklikler |
| 2 | `/api/admin/economy` izleme ucu | küçük | Sonraki adımların etkisi ölçülebilsin |
| 3 | Sıralama: maç başına ortalama + eşik | orta | Kümülatif kopuş başlamadan |
| 4 | Sezon altyapısı | orta | Sıralamanın üstüne oturur |
| 5 | Havuz (depo + uçlar + settle) | orta | Ekonomi dengelendikten sonra |
| 6 | Havuz mobil ekranı | ayrı | — |

**1 ve 2 birlikte bir oturumda** çıkar ve etkisi hemen ölçülebilir.

---

## Karar bekleyenler

1. **Bahis tavanı:** havuzun %25'i (önerim) · sabit 100 LC · tavan yok
2. **Premium 300 LC:** kalsın mı, düşürülüp ayrıcalığa mı çevrilsin
3. **Sezon uzunluğu:** aylık mı üç aylık mı
4. **İade eşiği:** `base >= 6` (önerim, ort. −0.23) · `base >= 12` (−0.78) · iade yok (−0.78)
