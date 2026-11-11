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
npm run dev          # geliştirme modu: 2 oyuncuyla oynanabilir, dosya değişince yeniden başlar
npm test             # birim + oyun motoru testleri
```

Odayı kuran kişi davet linkini paylaşır (`/?oda=KOD`); diğerleri adını yazıp katılır.
Aynı tarayıcıda farklı sekmeler farklı oyuncu sayılır, böylece tek başına da deneyebilirsin
(`npm run dev` ile 2 sekme yeterli).

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
| `SINYAL_DEV` | `1` ise geliştirme modu: 2 oyuncuyla başlanabilir |
| `SINYAL_CONFIG` | Başka bir config dosyası yolu |

> **Not:** Render'ın ücretsiz planında disk kalıcı değildir; servis uyuyup uyandığında ya da yeniden
> deploy edildiğinde `storage/` sıfırlanır. Takım rekorlarının kalıcı olmasını istiyorsan
> `DATABASE_URL` olarak bir PostgreSQL adresi ver (Render Postgres, Neon, Supabase…). Tablo
> (`sinyal_teams`) ilk açılışta otomatik oluşturulur. Oyunun kendisi veritabanı olmadan da çalışır.

## Ayarlar

Tüm sayısal değerler (süreler, can, satır sayıları, eşikler, zorluk seviyeleri, kaos kartları)
[`config/game.json`](config/game.json) dosyasındadır. Spec'teki değerlere ek olarak:

- `devMinPlayers`: geliştirme modunda gereken oyuncu sayısı
- `hostGraceSeconds`: oda sahibi koptuğunda yetkinin devredilmesi için beklenecek süre
- `emptyRoomSeconds`: kimsenin bağlı olmadığı odanın silinme süresi
- `requireApprovedPuzzles`: `true` ise sadece elle onaylanmış bulmacalar kullanılır
- `chaos.cards`: çekilebilecek kaos kartları
- `tiers[].maxRank`: o seviyede gizli kelime/tuzakların sıklık sırası üst sınırı (zorluk eğrisi)

## Kelime verisi (Faz 1)

`data/` klasöründeki dosyalar `scripts/build_data.py` ile üretilir ve repoya dahildir;
sunucunun çalışması için Python gerekmez.

| Dosya | İçerik |
|---|---|
| `words.tsv` | Sözlük (≈45 bin yalın kelime) ve sıklık sırası |
| `puzzles.json` | Bulmacalar: gizli kelime, tuzaklar, yasak harfler, seviye, `approved` |
| `puzzles_review.csv` | Elle onay için CSV çıktısı |
| `categories.json` | Kategori kilidi kartı için kelimeler (`categories_source.json`'dan süzülür) |
| `secret_exclude.txt` | Gizli kelime olmaması gereken bağlaç, edat vb. |
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
- `public/` — derleme gerektirmeyen istemci (HTML/CSS/JS), Türkçe Q ekran klavyesi

Gizli bilgiler (gizli kelime, tuzaklar, yasak harfler, köstebek kimliği) hiçbir zaman herkese
yayınlanan duruma yazılmaz; sadece ilgili oyuncuya özel mesajla gider ve hesaplaşmada açılır.
Sayaçlar sunucuda tutulur; istemciye `endsAt` gönderilir, istemci sadece geri sayımı çizer.

### Spec'ten bilinçli farklar

- **Next.js + Colyseus yerine** sade Node.js + `ws` ve derlemesiz bir istemci kullanıldı:
  tek bir Render Web Service olarak `npm start` ile çalışır, build adımı yoktur.
- **PostgreSQL isteğe bağlı:** sadece takım rekorları ve kullanılmış bulmacalar saklanır;
  bulmacalar ve sözlük repodaki dosyalardan okunur.
- **Yaygın kelime sınırı 10.000:** wordfreq'in Türkçe listesinde ≈11 bin TDK kelimesinin sıklığı
  var; 20.000 sınırı nadir kelimeleri de içine alıyordu.
