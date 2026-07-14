# SkorLig — Yol Haritası

İki ufuk: **(A) Tanıtım/Pilot dönemi** (bugün, minimum masraf) ve **(B) 500K üye** (nihai mimari).

---

## A. Başlangıç Senaryosu — "Dar ama çekici oyun"

Hedef: sağlayıcıya para vermeden, elle yönetilen küçük ama heyecanlı bir oyunla ilk topluluğu kurmak.

### A.1 Nasıl çalışır (bugünkü kod bunu zaten yapıyor)
1. **Admin 5–10 maç ekler** (ör. Dünya Kupası). Maç sayısı bilinçli az → her maça çok tahmin → kalabalık, canlı liste.
2. **Sonuçları admin elle girer.** Maçlar sekmesinde `?admin=1` → maça dokun → dk / skor / kırmızı / penaltı yaz → kaydet. Sağlayıcı sorgusu **sıfır**.
3. **Yazıldığı an işlem görür** → **canlı eleme panosu** (`/api/rt/match-race`): "Arjantin–İngiltere dk 16, 0-1, Kane kırmızı, penaltı Arjantin" girilince tahminler anında yeniden puanlanır. Herkes ilk 50'yi görür; kişi kendi anlık sırasını görür (351. gibi). 5 dk sonra 1-1 → sıralamalar önünde değişir.
4. **Kupon-yap-bekle modeli** de var: tahmin kilitlenir, sonuç gelince `settle2` puanlar. Az sorgu.

### A.2 Çekicilik kaldıraçları
- **Erken kuş bonusu** (kuruldu): ilk 1000 üyeye +200 LC başlangıç (`SKORLIG_EARLY_LIMIT` / `SKORLIG_EARLY_BONUS`). "İlk gelen kazanır" etkisi. `memberNo` kaydına yazılıyor → ileride "Kurucu Üye / İlk 1000" rozeti.
- **Küçük gruplaşmalar** (kuruldu): **Mini Turnuvalar** (2-10 maç, 6 haneli kod, arkadaş daveti) + **Arkadaş Ligi**. Viral çekirdek: bir kişi grup kurar, arkadaşlarını çağırır.
- **Haftalık ödüllü lig** (kuruldu): **Türkiye Tahmin Ligi** — Süper Lig'e paralel, ilk 3'e haftalık LC. Sezonda düzenli geri dönüş sebebi.
- **Canlı eleme heyecanı** (kuruldu): maç anı "3000→1200→400" düşüş dinamiği + kişisel anlık sıra. Uygulamada kalma (retention) motoru.

### A.3 Tanıtım dönemi ayarları (env)
```
SKORLIG_EARLY_LIMIT=1000     # ilk kaç üye bonus alır
SKORLIG_EARLY_BONUS=200      # erken kuş ekstra LC
SKORLIG_STORE_MODE=disabled  # tanıtımda satışı kapat, sadece kazanılan LC
SKORLIG_TR_W1=50             # haftalık ödülleri cömert tut (topluluk için)
SKORLIG_AF_SYNC=1            # az maç varken otomatik; elle girişte 0 yapılabilir
```
Not: Tanıtımda `STORE_MODE=disabled` → para almadan, LC tamamen oyun-içi kazanılır. Topluluk büyüyünce `mock`→gerçek IAP.

### A.4 İlk 90 gün akışı
- **Hafta 0:** 4-6 kişilik çekirdek, tek bir turnuva (ör. DK yarı final + final). Elle sonuç. Geri bildirim topla.
- **Ay 1:** Erken kuş açık, davet halkası. 10 maça kadar elle. TR Ligi'ni sezon açılışında devreye al.
- **Ay 2-3:** Mini turnuva viralitesi ölç. Retention iyiyse → `af-sync`'i tam aç (otomatik skor), erken kuş limitini kademeli kıs.

---

## B. 500K Üyeye Ölçekleme — Nihai Mimari

Bugünkü sistem **dosya-tabanlı** (JSON) ve pilot için ideal; ama 500K'da üç darboğaz var. Sıra önem sırasına göre.

### B.1 Darboğaz 1 — Depolama: JSON dosyası → MongoDB (KRİTİK)
- **Sorun:** `users.json`, `lc-wallet.json`, `preds.json` her yazımda tüm dosyayı okuyup yazıyor. 500K kullanıcı / milyonlarca tahminde imkânsız. (Ayrıca dosya kilidi yok → eşzamanlı yazımda veri kaybı riski.)
- **Çözüm:** Kod zaten **Mongo-hazır** — `settle2`, `lc-wallet`, `pred` içinde `db ? mongo : dosya` dalları var. Atlas cluster'ı geri aç (`MONGODB_URI` — şu an DNS ENOTFOUND, cluster silinmiş/duraklamış), Mongo yolunu birincil yap. İndeksler: `predictions{fixtureId, userIdLower}`, `lc_wallet_users{userIdLower}`, `match_results{fixtureId}`.
- **Geçiş:** Dosyalar tek seferlik import script'iyle Mongo'ya taşınır; dosya modu fallback kalır.

### B.2 Darboğaz 2 — Canlı puanlama: her istekte tüm tahminleri yeniden hesaplama
- **Sorun:** `match-race` / `scoreFixture` bir maçın **tüm** tahminlerini her çağrıda baştan puanlıyor. 1 maça 50K tahmin + binlerce eşzamanlı izleyici = CPU çöker.
- **Çözüm (kademeli):**
  1. **Olay-bazlı yeniden hesap + cache:** Skor sadece admin/af-sync state değiştirince değişir. O anda bir kez hesapla, sonucu (sıralı liste + herkesin puanı) cache'le (Redis/Mongo). İzleyici istekleri cache'ten okur — hesap yok.
  2. **Kişisel sıra O(log n):** İlk 50 herkese; "senin sıran 351." için tüm listeyi göndermeden, cache'lenmiş sıralı puan dizisinde ikili arama / sayaç. Kullanıcının puanından yüksek kaç kişi var → sırası.
  3. **Push/SSE:** 20 sn polling yerine, state değişince sunucudan itme (Server-Sent Events / WebSocket). 500K'da polling'i öldürür.

### B.3 Darboğaz 3 — Sağlayıcı maliyeti / veri
- **Pilot:** elle giriş + AF ücretsiz (100/gün) + TSDB (yedek). Bedava.
- **Ölçek:** binlerce maç → ücretli AF planı (aylık sabit, maç başı değil). `af-sync` mimarisi aynı kalır, sadece kota artar; `providers.json` kota yönetimi zaten var. Maliyet ancak gelir (premium/IAP) başlayınca devreye alınır — kod hazır (`STORE_MODE`, premium abonelik).

### B.4 Yatay ölçek / operasyon
- **Durumsuz API:** Express sunucusu durumsuz olmalı → N kopya + yük dengeleyici. (Bugünkü tek dosya-state buna engel; Mongo'ya geçiş bunu da çözer.)
- **af-sync tekilliği:** Arka plan senkron servisi **tek** kopyada çalışmalı (yoksa N kopya aynı maçı N kez settle eder). Ayrı worker süreç + kilit (Mongo lock) ya da tek "leader" instance.
- **İzleme:** `providers.json` sağlık + kota zaten var; ledger tam denetlenebilir. Prod'da hata/latency metrikleri eklenir.

### B.5 Veri bütünlüğü borçları (ölçekten önce kapatılmalı)
- **users.json ↔ lc-wallet.json sapması:** İki ayrı LC kaynağı (`u.lc` ve `wallet.balance`) var, senkron dışı kalabiliyor (oturumda 1 LC fark görüldü). **Tek doğru kaynak** seç (wallet), diğerini türet. Mongo geçişinde tek koleksiyon.
- **settle2 idempotency:** Mini/TR ligi/af-sync `settledAt`/`settledWeeks` ile korumalı; ana settle de fixture bazlı idempotent olmalı (kısmen var, netleştir).

---

## Özet öncelik sırası
1. **Şimdi:** Pilotu bugünkü kodla başlat (elle giriş, erken kuş, mini gruplar, canlı pano). Kod hazır.
2. **Retention kanıtlanınca:** MongoDB'yi geri aç → birincil depolama. (En kritik ölçek adımı.)
3. **Trafik artınca:** Canlı puanlama cache + push. Yatay ölçek.
4. **Gelir başlayınca:** Ücretli sağlayıcı + IAP.
5. **Sürekli:** LC tek-kaynak mutabakatı, idempotency, izleme.
