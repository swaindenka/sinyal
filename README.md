# SİNYAL

Konuşamayan kaptan, tek kartlık sinyal, bütün takım tek karar.

SİNYAL, 2–8 kişilik bir ekibin tarayıcıda, sesli sohbet (Discord vb.) eşliğinde birlikte oynadığı
gerçek zamanlı bir **çağrışım kart oyunu**. Hesap ve kurulum gerektirmez; telefon ve bilgisayarda çalışır.

## Nasıl oynanır

1. Masada **8 kelime kartı** var. Her turda sıradaki oyuncu **kaptan** olur ve hangi kartın **hedef**,
   hangilerinin **parazit** olduğunu yalnızca o görür. Kaptan konuşamaz.
2. Kaptan elindeki **6 kelime kartından** birini **sinyal** olarak oynar (ör. hedef BULUT için PAMUK).
   Turda bir kez elini tamamen değiştirebilir.
3. Takım konuşur ve **jetonlarını** kartlara koyar. Bütün tahmincilerin jetonu aynı kartta birleşince
   3 saniyelik geri sayımla kart açılır. **Pas** alanında birleşilirse kart açılmadan yeni sinyal istenir.
4. Hedef 1. sinyalden sonra bulunursa **3**, 2.den sonra **2**, 3.den sonra **1** puan. Boş kart çıkarsa
   kaptan yeni sinyal oynar. **Parazit** ya da 3 sinyalde bulamamak **1 can** götürür.
5. Takım 3 canla başlar, her 5 isabette 1 can geri gelir. Canlar bitince oyun biter ve skor takım
   adına rekor olarak kaydedilir.

Turlar ilerledikçe parazitler artar ve hedefle **aynı kategoriden** gelmeye başlar (hedef KEDİ,
parazit KÖPEK). Kaptanın elinde her zaman hedefin kategorisinden bir kart bulunur: ilk turlarda
güvenli bir ipucudur, sonra tuzağa dönüşür.

| Seviye | Tur | Parazit | Hedefe benzeyen parazit | Süre (sinyal / karar) |
|---|---|---|---|---|
| Isınma | 1–3 | 1 | 0 | 45 / 60 sn |
| Kolay | 4–6 | 1 | 1 | 45 / 60 sn |
| Orta | 7–9 | 2 | 1 | 45 / 60 sn |
| Zor | 10–12 | 2 | 2 | 45 / 50 sn |
| Usta | 13+ | 3 | 2 | 35 / 45 sn |

Tasarımın gerekçeleri ve ayrıntılı kurallar: [`docs/TASARIM.md`](docs/TASARIM.md). İlk sürümün
(harf renkli kelime oyunu) dokümanı tarih olarak [`docs/SINYAL_SPEC.md`](docs/SINYAL_SPEC.md)'de duruyor.

## Hızlı başlangıç

```bash
npm install
npm start          # http://localhost:3000
npm test           # birim + entegrasyon testleri
npm run dev        # dosya değişince yeniden başlar
```

Bir sekmede oda kur, başka bir tarayıcıda ya da gizli pencerede davet linkini açıp katıl.
(Aynı tarayıcının iki sekmesi de olur; oturum sekmeye özeldir.)

## Render'da yayınlama

**Blueprint ile (önerilen):** Render Dashboard → **New → Blueprint** → bu repoyu seç.
`render.yaml` her şeyi ayarlar (ücretsiz Web Service, `npm ci` / `npm start`, `/health` kontrolü).

**Elle:** New → Web Service → repo; Runtime **Node**, Build `npm ci`, Start `npm start`,
Health Check Path `/health`.

WebSocket bağlantıları Render'da ek ayar gerektirmez; sunucu `PORT` değişkenini kendisi okur.

### Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PORT` | Dinlenecek port (Render otomatik verir) |
| `DATABASE_URL` | İsteğe bağlı PostgreSQL adresi. Verilirse takım rekorları burada tutulur (tablo `sinyal_teams_v2`) |
| `DATA_DIR` | `DATABASE_URL` yoksa kayıtların yazılacağı klasör (varsayılan `./storage`, dosya `teams-v2.json`) |
| `SINYAL_CONFIG` | Başka bir oyun ayar dosyası kullanmak için yol |

> **Ücretsiz plan uykusu:** Render'ın ücretsiz servisi 15 dk istek almazsa uyur; ilk açılış ~1 dk
> sürebilir. Odada oyuncu varken istemci birkaç dakikada bir `/health` isteği atar, oyun sırasında
> servis uyumaz. Sunucu yeniden başlarsa açık odalar kapanır ve oyuncular giriş ekranına döner.

> **Kalıcı rekorlar:** Ücretsiz planda disk kalıcı değildir. Rekorların silinmemesi için
> `DATABASE_URL` olarak bir PostgreSQL adresi ver (Render Postgres, Neon, Supabase…). Tablo kendiliğinden
> oluşturulur; veritabanına ulaşılamazsa oyun yine açılır ve kayıtlar dosyaya yazılır.

## Ayarlar

Bütün sayılar [`config/game.json`](config/game.json)'da:

| Anahtar | Varsayılan | Anlamı |
|---|---|---|
| `minPlayers` / `maxPlayers` | 2 / 8 | Oyuncu sınırları |
| `lives`, `lifeEveryHits` | 3, 5 | Başlangıç canı; kaç isabette bir can geri gelir (0: hiç) |
| `boardSize` | 8 | Masadaki kart sayısı |
| `maxSignals`, `points` | 3, [3, 2, 1] | Turdaki sinyal hakkı ve kaçıncı sinyalde kaç puan |
| `handSize`, `handNitelik`, `handKin` | 6, 2, 1 | El büyüklüğü; kaçı sıfat, kaçı hedefin kategorisinden |
| `redrawsPerRound` | 1 | Turda kaç kez el değiştirilebilir |
| `signalSeconds`, `guessSeconds` | 45, 60 | Kaptanın sinyal, takımın karar süresi |
| `lockSeconds` | 3 | Jetonlar birleşince kartın açılmasına kalan süre |
| `revealSeconds` | 6 | Tur sonucunun ekranda kalma süresi |
| `playerReconnectSeconds`, `hostGraceSeconds` | 60, 10 | Kopan oyuncunun yerini koruma, oda sahipliğinin devri |
| `levels` | | Seviyeler: başladığı tur, parazit sayısı, hedefe benzeyen parazit (`near`) ve boş kart (`decoys`), isteğe bağlı süreler |

## Kelime destesi

[`data/cards.json`](data/cards.json) elle derlenmiştir:

- `categories`: masadaki kartlar, 13 kategoride 521 somut ve herkesin bildiği kelime
  (hayvan, yiyecek, ev, doğa, taşıt, meslek, giysi, yer, spor, sanat, vücut, teknoloji, masal).
- `nitelik`: 106 sıfat (SICAK, SİVRİ, TATLI…). Her elde 2 tane bulunur.
- `kavram`: 140 soyut ya da çok anlamlı kelime (RÜYA, KORKU, GECE…).

Kelime eklemek için listeye yazman yeterli: en fazla 10 harf, Türkçe büyük harf (İ/I'ye dikkat),
her kelime yalnızca bir listede. `npm test` kuralları denetler. Birbirini içeren ya da ilk 4 harfi
aynı kelimeler (KAR/KARPUZ, KRAL/KRALİÇE) aynı tahtaya ya da ele gelmez.

## Yapı

```
server/
  index.js    HTTP (statik dosyalar, /health) + WebSocket, oda kayıtları
  room.js     oyun motoru: LOBBY → SIGNAL → GUESS → REVEAL → … → END
  deck.js     tahta ve el dağıtımı, çakışma kuralı
  store.js    takım rekorları (PostgreSQL ya da dosya)
public/
  index.html, style.css, app.js, icons.js, fonts/ (Oswald, OFL)
data/cards.json   kelime destesi
config/game.json  oyun ayarları
test/             node:test birim ve entegrasyon testleri
```

Sunucu otoriterdir: kartların rolleri ve kaptanın eli yalnızca kaptana özel mesajla gider, herkese
yayınlanan durumda yer almaz.
