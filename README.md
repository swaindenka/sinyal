# SİNYAL

Takımca, sesli iletişimle (Discord vb.) oynanan, gerçek zamanlı bir Türkçe kelime oyunu.
Kaptan gizli kelimeyi bilir ama konuşamaz; sadece **sinyal kelimeleri** gönderir. Her sinyal
hem **anlamıyla** hem de **Wordle renkleriyle** bilgi taşır. Tahminciler tuzaklara düşmeden
gizli kelimeyi bulmaya çalışır.

Kuralların tamamı: [`docs/SINYAL_SPEC.md`](docs/SINYAL_SPEC.md)

## Hızlı başlangıç

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # dosya değişince sunucuyu yeniden başlatır
npm test             # birim + oyun motoru testleri
```

Odayı kuran kişi davet linkini paylaşır (`/?oda=KOD`); diğerleri adını yazıp katılır.
Oyun **2–8 kişiyle** oynanır. İki kişide biri kaptan, diğeri tahminci olur; tek tahmincinin
tahmini, pası ve kumbara isteği onay beklemeden uygulanır (köstebek kartı en az 3 tahminci ister,
2–3 kişide çıkmaz). Aynı tarayıcıda farklı sekmeler farklı oyuncu sayılır, böylece iki sekmeyle
tek başına da deneyebilirsin.

**Oda sahibi** takım adını belirler, kaptan sırasını düzenler ya da karıştırır, oyunu duraklatır,
hesaplaşmayı erken bitirir ve gerekirse bir oyuncuyu odadan çıkarır (ör. ekran başında olmayan biri
onay eşiğini tıkıyorsa). Oda sahibi 10 sn'den uzun koparsa yetki sıradaki bağlı oyuncuya geçer.

Sayfayı yenileyen ya da bağlantısı kopan oyuncu 60 sn içinde döndüğünde yerini korur; kaptan
koparsa oyun 30 sn bekler. Telefonda sekmeye geri dönüldüğünde bağlantı hemen yenilenir.

## Render'da yayınlama

**Blueprint ile (önerilen):** Render Dashboard → **New → Blueprint** → bu repoyu seç.
`render.yaml` her şeyi ayarlar (ücretsiz Web Service, `npm ci` / `npm start`, `/health` kontrolü).

**Elle:** **New → Web Service** → repo → Runtime: Node, Build: `npm ci`, Start: `npm start`.

WebSocket bağlantıları Render'da ek ayar gerektirmez; sunucu `PORT` değişkenini kendisi okur.

### Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PORT` | Dinlenecek port (Render otomatik verir) |
| `DATABASE_URL` | İsteğe bağlı PostgreSQL adresi. Verilirse takım rekorları ve kullanılmış bulmacalar burada tutulur |
| `DATA_DIR` | `DATABASE_URL` yoksa kayıtların yazılacağı klasör (varsayılan `./storage`) |
| `SINYAL_DEV` | `1` ise geliştirme modu: config'de `devMinPlayers` varsa o kadar oyuncuyla başlanabilir |
| `SINYAL_CONFIG` | Başka bir config dosyası yolu |

> **Ücretsiz plan uykusu:** Render ücretsiz servisi 15 dk istek almazsa uyur ve ilk açılış ~1 dk
> sürebilir. Odada oyuncu varken istemci birkaç dakikada bir `/health` isteği atar, böylece oyun
> ortasında uykuya geçmez.
>
> **Not:** Render'ın ücretsiz planında disk kalıcı değildir; servis uyuyup uyandığında ya da yeniden
> deploy edildiğinde `storage/` sıfırlanır. Takım rekorlarının kalıcı olmasını istiyorsan
> `DATABASE_URL` olarak bir PostgreSQL adresi ver (Render Postgres, Neon, Supabase…). Tablo
> (`sinyal_teams`) ilk açılışta otomatik oluşturulur. Oyunun kendisi veritabanı olmadan da çalışır.

## Ayarlar

Tüm sayısal değerler (süreler, can, satır sayıları, eşikler, zorluk seviyeleri, kaos kartları)
[`config/game.json`](config/game.json) dosyasındadır. Spec'teki değerlere ek olarak:

- `hostGraceSeconds`: oda sahibi koptuğunda yetkinin devredilmesi için beklenecek süre
- `emptyRoomSeconds`: kimsenin bağlı olmadığı odanın silinme süresi
- `requireApprovedPuzzles`: `true` ise sadece elle onaylanmış bulmacalar kullanılır
- `chaos.cards`: çekilebilecek kaos kartları
- `puzzleLengths`: bulmaca üretilecek kelime uzunlukları (varsayılan 5, 6, 7)
- `showTrapPosition`: tahmincilere tuzağın hangi harfte ayrıldığını göster (harfleri değil, yalnızca konumu)
- `tiers[]`: seviyeler — `name`, hangi kelimeden başladığı (`fromWord`), kelime uzunlukları, tuzak
  sayısı, satır sayısı, `consonantOnly` ve `difficulty` (0–100 zorluk bandı)

## Zorluk ve seviyeler

Her bulmacaya `scripts/build_data.py` 0–100 arası bir zorluk puanı verir:

| Bileşen | Ağırlık | Neden zorlaştırır |
|---|---|---|
| Nadirlik | %42 | Gizli kelime az kullanılıyorsa tahmin etmek zor |
| Cazip tuzak | %18 | Tuzak gizli kelimeden daha yaygınsa tahminciler oraya kayar (YARAN / YARIN) |
| Sinyal kıtlığı | %16 | Yasak harfler yüzünden kaptanın kullanabileceği kelime oranı düşük |
| Şaşırtmaca | %14 | Aynı kalıba uyan, tuzak olmayan başka kelimeler boşa satır harcatır |
| Sesli fark | %10 | Yasak harflerden biri sesliyse sinyal bulmak çok zorlaşır |

Seviyeler (`config/game.json`):

| Seviye | Kelime | Harf | Tuzak | Satır | Zorluk |
|---|---|---|---|---|---|
| 1 Isınma | 1–3 | 5 | 1 (ünsüz farkı) | 6 | 0–38 |
| 2 Kolay | 4–6 | 5–6 | 1 (ünsüz farkı) | 6 | 20–50 |
| 3 Orta | 7–9 | 6–7 | 1 | 5 | 30–60 |
| 4 Zor | 10–12 | 5–6 | 2 | 5 | 35–65 |
| 5 Çok zor | 13–15 | 6–7 | 2 | 5 | 40–100 |
| 6 Usta | 16+ | 5–7 | 2–3 | 4 | 50–100 |

Bir seviyede kullanılmamış bulmaca kalmazsa bir alt seviyeden seçilir. `build_data.py` her seviyede
kaç bulmaca ve gizli kelime olduğunu yazdırır; bantları değiştirdikten sonra çalıştırıp kontrol et.

## Kelime verisi (Faz 1)

`data/` klasöründeki dosyalar `scripts/build_data.py` ile üretilir ve repoya dahildir;
sunucunun çalışması için Python gerekmez.

| Dosya | İçerik |
|---|---|
| `words.tsv` | Sözlük (≈45 bin yalın kelime) ve sıklık sırası |
| `puzzles.json` | Bulmacalar: gizli kelime, tuzaklar, yasak harfler, seviye, `approved` |
| `puzzles_review.csv` | Elle onay için CSV çıktısı |
| `categories.json` | Kategori kilidi kartı için kelimeler (`categories_source.json`'dan süzülür) |
| `secret_exclude.txt` | Gizli kelime olmaması gereken bağlaç, zamirli biçim, özel isim gibi duran kelimeler |
| `extra_words.txt` | TDK listesinde olmayan ama yaygın kelimeler (internet, emoji…) |
| `profanity_extra.txt` / `profanity_allow.txt` | Küfür filtresine ekler / istisnalar |

Kaynaklar: TDK kelime listesi ([mertemin/turkish-word-list](https://github.com/mertemin/turkish-word-list)),
sıklık için [wordfreq](https://github.com/rspeer/wordfreq), küfür listesi
([ooguz/turkce-kufur-karaliste](https://github.com/ooguz/turkce-kufur-karaliste)).

```bash
pip install wordfreq
python3 scripts/build_data.py                          # veriyi yeniden üret
python3 scripts/build_data.py --approvals onaylar.csv  # CSV'deki approved sütununu uygula
```

Bulmaca onayı: `puzzles_review.csv`'yi bir tablo programında aç, beğendiğin satırlarda `approved`
sütununu `1` yap, kaydedip `--approvals` ile uygula, sonra `config/game.json`'da
`requireApprovedPuzzles: true` yap. Yeniden üretimde mevcut onaylar korunur.

## Mimari

- `server/room.js` — oyun motoru ve durum makinesi
  (`LOBBY → WORD_SETUP → SIGNAL ⇄ DISCUSSION → [MOLE_VOTE] → REVEAL → … → RUN_END`).
  Sunucu otoriterdir: tüm doğrulama ve renk hesabı burada yapılır.
- `server/score.js` — renk algoritması (tekrarlayan harfler dahil)
- `server/data.js` — sözlük, kategoriler, bulmaca seçimi (seviye ve geriye düşme)
- `server/store.js` — takım rekorları (dosya ya da PostgreSQL)
- `server/index.js` — HTTP (statik dosyalar, `/health`) + WebSocket (`/ws`)
- `public/` — derleme gerektirmeyen istemci (HTML/CSS/JS modülleri), Türkçe Q ekran klavyesi.
  Görsel dil bir kart masasıdır: oynanan her satır krem renkli bir kelime kartıdır (kaptanın
  sinyalleri koyu "kaptan kartı", tuzak siyah ve damgalı), kalan satırlar ters çevrilmiş deste,
  kaptanın gizli bilgisi bir "dosya". Harf ipucu harflerin altındaki renk çizgileridir: mavi tam
  yer, turuncu kelimede var, gri yok. Tasarım `style.css`'teki tokenlarla açık/koyu temayı cihaz
  ayarına göre seçer; ikonlar `icons.js`'teki satır içi SVG'ler, kart yazı tipi sunucudan
  sunulan Oswald'dır (`public/fonts`, SIL Open Font License). Klavye yalnızca yazarken açılır.

Gizli bilgiler (gizli kelime, tuzaklar, yasak harfler, köstebek kimliği) hiçbir zaman herkese
yayınlanan duruma yazılmaz; sadece ilgili oyuncuya özel mesajla gider ve hesaplaşmada açılır.
Sayaçlar sunucuda tutulur; istemciye `endsAt` gönderilir, istemci sadece geri sayımı çizer.

### Spec'ten bilinçli farklar

- **En az 2 oyuncu** (spec'te 3): iki kişide tek tahminci olduğu için öneriler hemen gönderilir.

- **Next.js + Colyseus yerine** sade Node.js + `ws` ve derlemesiz bir istemci kullanıldı:
  tek bir Render Web Service olarak `npm start` ile çalışır, build adımı yoktur.
- **PostgreSQL isteğe bağlı:** sadece takım rekorları ve kullanılmış bulmacalar saklanır;
  bulmacalar ve sözlük repodaki dosyalardan okunur.
- **Yaygın kelime sınırı 10.000:** wordfreq'in Türkçe listesinde ≈11 bin TDK kelimesinin sıklığı
  var; 20.000 sınırı nadir kelimeleri de içine alıyordu.
