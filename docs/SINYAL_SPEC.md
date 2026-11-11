# SİNYAL — Oyun Tasarım Dokümanı (v1)

> **Claude Code için not:** Bu doküman oyunun kurallarını ve mantığını tanımlar. Tüm sayısal değerler (süreler, satır sayıları, eşikler) koda gömülmemeli, tek bir config dosyasından okunmalıdır (bkz. Bölüm 13). Geliştirmeye Bölüm 12'deki **Faz 1** ile başla.

---

## 1. Özet

SİNYAL, 3–8 kişilik **tek bir takımın** aynı anda, sesli iletişimle (Discord vb.) oynadığı, iş birliğine dayalı bir Türkçe kelime oyunudur.

Her kelimede takımdan biri **kaptan** olur. Kaptan gizli kelimeyi bilir ama **konuşamaz**; sadece **sinyal kelimeleri** gönderebilir. Her sinyal iki kanaldan bilgi taşır:

1. **Anlam kanalı:** Sinyalin anlamı gizli kelimeyi çağrıştırır (Codenames gibi).
2. **Harf kanalı:** Sinyal, gizli kelimeye göre Wordle renkleriyle gösterilir.

Diğer oyuncular (**tahminciler**) iki kanalı birlikte yorumlayıp tartışarak gizli kelimeyi bulmaya çalışır.

Gizli kelimenin tek harf farklı "kardeşleri" arasından seçilen **tuzaklar** vardır; tuzağı tahmin etmek can kaybettirir. Kaptan, gizli kelimeyi tuzaklardan ayıran harfleri (**yasak harfler**) sinyallerinde kullanamaz. Bu yüzden en kritik ayrımı ancak anlam kanalıyla verebilir.

Takım, canları bitene kadar art arda kelime çözer. Amaç takım rekorunu kırmaktır. Kaptanlık her kelimede sıradaki oyuncuya geçer.

---

## 2. Terimler

| Terim | Açıklama |
|---|---|
| **Oyun (run)** | Canlar bitene kadar süren kelime dizisi |
| **Kelime turu** | Tek bir gizli kelimenin oynandığı bölüm |
| **Kaptan** | O kelime turunda gizli bilgiyi gören, konuşamayan oyuncu |
| **Tahminci** | Kaptan dışındaki oyuncular |
| **Gizli kelime** | Bulunması gereken kelime |
| **Aile** | Aynı uzunlukta, **aynı tek konumda** birbirinden ayrılan kelimeler. Örn. `KA_AK` → KABAK, KAPAK, KAVAK, KAZAK, KAYAK, KAÇAK |
| **Tuzak** | Aileden seçilen, tahmin edilirse can kaybettiren kelime(ler) |
| **Yasak harfler** | Gizli kelime ve tuzakların ayrıldığı konumdaki harfler. Kaptan bunları sinyalde **hiçbir konumda** kullanamaz |
| **Satır** | Tahtadaki her kayıt: sinyal, tahmin veya boş satır. Her kelime turunun bir satır limiti vardır |
| **Kumbara** | Çözülen kelimelerde kullanılmayan satırların biriktiği ortak havuz |
| **Can** | Takımın hata hakkı |
| **Yıldız** | En fazla 1 sinyalle çözülen kelime için verilen bonus |

**Örnek:** Gizli kelime KABAK, tuzaklar KAPAK ve KAVAK → yasak harfler **B, P, V**. Kaptan sinyallerinde B, P ve V harflerini hiçbir yerde kullanamaz. Ailenin diğer üyeleri (KAZAK, KAYAK, KAÇAK) tuzak değildir; tahmin edilirlerse normal yanlış tahmin sayılır.

---

## 3. Oyuncular ve Lobi

- 3–8 oyuncu. (Geliştirme modunda 2 oyuncuya izin verilir.)
- Odaya oda koduyla girilir, kullanıcı adı yazılır. Hesap açmak zorunlu değildir.
- Odayı kuran kişi **host** olur. Host takım adını belirler, oyunu başlatır, kaptan sırasını düzenleyebilir, oyunu duraklatabilir.
- Kaptan sırası oyun başında rastgele belirlenir.
- Oyun sırasında katılan oyuncu kaptan sırasının sonuna eklenir ve tahminci olarak başlar.
- Host ayrılırsa host yetkisi sıradaki bağlı oyuncuya geçer.
- MVP'de oyun içi metin sohbeti yoktur; iletişim Discord sesi üzerinden yapılır.

---

## 4. Oyun Akışı

### 4.1 Oyun başlangıcı

- Can: **3** (en fazla 3)
- Kumbara: **0**
- Kelime sayacı: **1**

### 4.2 Bir kelime turunun akışı

1. **Hazırlık (5 sn):** Sıradaki oyuncu kaptan olur ve gizli bilgiler kaptana gönderilir. Herkese şunlar duyurulur: harf sayısı, tuzak sayısı, yasak harf sayısı, satır limiti ve varsa kaos kartı.
2. **Sinyal aşaması (45 sn)** — bkz. 4.3
3. **Tartışma aşaması (90 sn)** — bkz. 4.4
4. Kelime bitene kadar 2. ve 3. adımlar tekrarlanır.
5. **Köstebek oylaması (30 sn)** — sadece Köstebek kartı varsa (bkz. 6.1)
6. **Hesaplaşma (30 sn)** — bkz. 4.6
7. Can 0 ise oyun sonu, değilse sıradaki kelime turu.

### 4.3 Sinyal aşaması

- Kaptan bir sinyal kelimesi gönderir. Sinyal tahtaya satır olarak eklenir ve renkleriyle birlikte herkese gösterilir.
- Kaptan, göndermeden önce kendi ekranında **canlı önizleme** görür: hangi renklerin çıkacağını, kelime geçersizse de nedenini.
- Süre dolarsa tahtaya **boş satır** eklenir (satır harcanır) ve tartışmaya geçilir.
- **Kalan satır 1 ise sinyal aşaması atlanır** ve doğrudan tartışmaya geçilir. Son satır yalnızca tahmin içindir.

**Sinyal geçerlilik kuralları:**

1. Gizli kelimeyle aynı uzunlukta olmalı.
2. Sözlükte geçerli bir kelime olmalı.
3. Yasak harflerden hiçbirini, hiçbir konumda içermemeli.
4. Bu kelime turunda daha önce sinyal veya tahmin olarak kullanılmamış olmalı.
5. (Kategori kilidi kartı varsa) Duyurulan kategoriye ait olmalı.

> 3. kural, gizli kelimenin ve tuzakların sinyal olarak gönderilmesini de kendiliğinden engeller.

### 4.4 Tartışma aşaması

- Tahminciler sesli olarak tartışır. Kaptan konuşamaz (onur kuralı). Oyunda kaptanın öneri ve onay düğmeleri kapalıdır.
- Tahmincilerin yapabileceği eylemler:
  - **Tahmin önerisi:** Bir kelime önerir.
  - **Onay:** Başka birinin önerisini onaylar.
  - **Pas önerisi / onayı**
  - **Kumbara talebi / onayı**
- **Onay eşiği:** Tahmincilerin salt çoğunluğu, yani `floor(T / 2) + 1` (T = bağlı tahminci sayısı). Öneren kişi otomatik olarak onaylamış sayılır.

  | T | 2 | 3 | 4 | 5 | 6 | 7 |
  |---|---|---|---|---|---|---|
  | Gereken onay | 2 | 2 | 3 | 3 | 4 | 4 |

- Eşiğe ilk ulaşan öneri gönderilir. O anda açık olan diğer öneriler silinir.
- Bir tartışma aşamasında **en fazla 2 tahmin** gönderilebilir.

**Tahmin geçerlilik kuralları:** Aynı uzunlukta olmalı, sözlükte geçerli olmalı, bu turda daha önce kullanılmamış olmalı. Yasak harf kuralı tahmincilere uygulanmaz; tahminciler yasak harfleri bilmez.

**Tahmin sonucu:**

| Sonuç | Etki |
|---|---|
| Gizli kelime | Kelime çözüldü (bkz. 4.5) |
| Tuzak | Kelime başarısız, can −1 |
| Yanlış | Tahmin renkleriyle tahtaya eklenir. Satırlar bittiyse kelime başarısız, can −1. Bu aşamadaki 2. tahminse sinyal aşamasına geçilir. Değilse tartışma devam eder (süre sıfırlanmaz). |

**Pas ve süre:**

- Pas onaylanırsa ya da süre hiç tahmin yapılmadan dolarsa sinyal aşamasına geçilir. Pas satır harcamaz.
- 1 tahmin yapılmışken süre dolarsa sinyal aşamasına geçilir.
- **Son satırda pas yoktur.** Kalan satır 1 iken süre dolarsa kelime başarısız sayılır ve can −1.

**Kumbara:**

- Tartışma sırasında herhangi bir tahminci kumbaradan 1 satır çekilmesini önerebilir.
- **Bütün tahmincilerin onayı** gerekir (oybirliği).
- Onaylanırsa kumbara −1, bu kelimenin satır limiti +1 olur.
- Kumbaranın üst sınırı 10'dur.

### 4.5 Kelime sonu

- **Çözüldü:**
  - Kullanılmayan satırlar kumbaraya eklenir (üst sınıra kadar).
  - Çözülen kelime sayısı +1.
  - Kelime en fazla 1 sinyalle çözüldüyse +1 yıldız. Boş satırlar sinyal sayılmaz.
- **Başarısız (tuzak ya da satırlar bitti):** Can −1. Kalan satırlar kumbaraya eklenmez.
- **Can kazanma:** Her 5 çözülen kelimede +1 can (en fazla 3).

### 4.6 Hesaplaşma

- Herkese gösterilir: gizli kelime, tuzaklar, yasak harfler ve tahtadaki tüm satırlar.
- Kaptan artık konuşabilir ve sinyallerini açıklar. Bu aşama bilerek tartışma alanı olarak tasarlanmıştır.
- Host "Devam" diyerek aşamayı erken bitirebilir.

### 4.7 Oyun sonu

- Can 0 olduğunda oyun biter.
- **Skor = çözülen kelime sayısı.** Eşitlikte yıldız sayısına bakılır.
- Takım rekoru (takım adına göre) güncellenir.
- İstatistik ve ödül ekranı gösterilir (bkz. Bölüm 8).

---

## 5. Zorluk Eğrisi

| Kelime no | Harf | Tuzak | Yasak harf | Satır | Not |
|---|---|---|---|---|---|
| 1–3 | 5 | 1 | 2 | 6 | Fark sadece ünsüzde |
| 4–6 | 5–6 | 1 | 2 | 5 | Fark sadece ünsüzde |
| 7–9 | 6 | 2 | 3 | 5 | Ünlü farkı olabilir |
| 10+ | 6–7 | 2–3 | 3–4 | 4 | |

- Yasak harf sayısı = tuzak sayısı + 1, çünkü tüm tuzaklar gizli kelimeden aynı konumda ayrılır.
- İstenen seviyede kullanılmamış bulmaca kalmadıysa bir alt seviyeden seçilir.

---

## 6. Kaos Kartları

4. kelimeden itibaren her 3 kelimede bir (4, 7, 10, 13…) rastgele bir kart çekilir ve hazırlık aşamasında herkese duyurulur.

| Kart | Etki |
|---|---|
| **Kategori kilidi** | Sinyaller sadece duyurulan kategoriden olabilir (hayvan, yemek, meslek, eşya, doğa…). Kategori etiketli kelime verisi gerekir. Seçilen kategoride, yasak harfler hesaba katıldığında en az 5 geçerli sinyal yoksa başka bir kategori veya kart seçilir. |
| **Kör renk** | Bu turda sarılar gri gösterilir (sinyallerde ve tahminlerde). Kaptanın önizlemesi de buna göre gösterilir. |
| **Hızlı tur** | Sinyal süresi 30 sn, tartışma süresi 45 sn olur. |
| **Köstebek** | Tahmincilerden biri gizlice köstebek olur (bkz. 6.1). En az 3 tahminci gerekir; daha azsa başka bir kart çekilir. |

### 6.1 Köstebek

- Tahmincilerden biri rastgele köstebek olur ve gizli kelimeyi ve tuzakları görür. Kimliğini sadece kendisi bilir; kaptan da bilmez.
- **Amacı:** Takımı bir tuzağı tahmin etmeye ikna etmek.
- Köstebek de normal bir tahminci gibi öneri yapabilir ve onay verebilir.
- Kelime bittiğinde, sonuç ne olursa olsun oylama yapılır: kaptan dahil tüm oyuncular bir kişiye oy verir.
- En çok oyu alan kişi köstebekse köstebek yakalanmış sayılır. Eşitlikte yakalanmamış sayılır.
- Yakalanırsa takım +1 can kazanır (en fazla 3).
- Takım tuzağa düştüyse köstebek "başarılı" sayılır (istatistik için).

---

## 7. Kim Neyi Görür

| Bilgi | Kaptan | Tahminci | Köstebek |
|---|---|---|---|
| Gizli kelime | ✓ | – | ✓ |
| Tuzaklar | ✓ | – | ✓ |
| Yasak harfler | ✓ | – | ✓ |
| Harf, tuzak ve yasak harf **sayıları** | ✓ | ✓ | ✓ |
| Tahta (satırlar ve renkler) | ✓ | ✓ | ✓ |
| Sinyal önizlemesi | ✓ | – | – |
| Köstebek kimliği | – | – | ✓ (kendisi) |

**Kural:** Gizli bilgiler hiçbir zaman herkese eşitlenen ortak duruma (shared state) yazılmaz. Sadece ilgili oyuncuya özel mesajla gönderilir. Hesaplaşmada herkese açılır.

---

## 8. İstatistikler ve Ödüller

**Oyuncu bazında tutulanlar:**

- **Kaptanlık:** kaptan olunan kelime sayısı, çözülen kelime, ortalama kullanılan satır, yıldız
- **Tahmin:** önerdiği ve gönderilen tahminler; bunlardan doğru çıkanlar ve tuzak çıkanlar
- **Köstebek:** köstebek olunan turlar, başarılı olunanlar, yakalanılanlar; köstebeğe verilen doğru oy sayısı

**Oyun sonu ödülleri:**

| Ödül | Ölçüt |
|---|---|
| Efsane Kaptan | Çözülen kelime başına en düşük ortalama satır (en az 1 çözüm) |
| Kâhin | En çok doğru tahmin öneren |
| Tuzakçı | En çok tuzak öneren |
| Köstebek Avcısı | Köstebeğe en çok doğru oy veren |
| Usta Köstebek | Takımı tuzağa düşürüp yakalanmayan |

Eşitlikte ödül paylaşılır. Ölçütü karşılayan kimse yoksa ödül gösterilmez.

---

## 9. Kelime Verisi ve Türkçe Kuralları

### 9.1 Alfabe ve normalizasyon

- Alfabe (29 harf): `A B C Ç D E F G Ğ H I İ J K L M N O Ö P R S Ş T U Ü V Y Z`
- Tüm karşılaştırmalar normalize edilmiş büyük harfle yapılır: `toLocaleUpperCase('tr-TR')` (i → İ, ı → I).
- Şapkalı harfler sadeleştirilir: Â → A, Î → İ, Û → U.
- Alfabe dışı karakter (Q, W, X, boşluk, tire, rakam) içeren kelimeler geçersizdir.
- Ekranda Türkçe Q klavye düzeni bulunur (mobil dahil).

### 9.2 Sözlük

- Sadece yalın (sözlük) halleri kabul edilir, çekimli halleri değil.
- Özel isimler, kısaltmalar ve çok kelimeli ifadeler çıkarılır.
- Argo ve küfürler bir listeyle filtrelenir; gizli kelime ya da sinyal olarak kullanılamazlar.
- Her kelimenin sıklık sırası tutulur.
- Gizli kelimeler ve tuzaklar **yaygın** kelimelerden seçilir (örneğin en sık kullanılan ilk 20.000). Sinyaller ve tahminler için sözlükteki her geçerli kelime kabul edilir.

### 9.3 Aile ve bulmaca üretimi

```python
buckets = defaultdict(list)
for word in common_words:
    for i in range(len(word)):
        pattern = word[:i] + "_" + word[i+1:]
        buckets[(pattern, i)].append(word)

families = {k: v for k, v in buckets.items() if len(v) >= 2}
```

- **Bulmaca** = (gizli kelime, tuzak listesi, yasak harfler, zorluk seviyesi). Hepsi aynı aileden seçilir.
- **Yasak harfler** = ailenin ayrıldığı konumda, gizli kelimeye ve tuzaklara ait harfler.
- 1–6. kelimelerin bulmacalarında ayrılan harfler ünsüz olmalıdır.
- Üretilen bulmacalar `approved = false` olarak kaydedilir ve elle onaylanınca oyuna girer. Onay için CSV çıktısı alınır.
- Bir takıma aynı bulmaca ikinci kez verilmez.

### 9.4 Renk algoritması (tekrarlayan harfler dahil)

```text
function score(guess, secret):
    n = length(secret)
    result = [GRAY] * n
    remaining = harf sayımı(secret)

    // 1. geçiş: yeşiller
    for i in 0..n-1:
        if guess[i] == secret[i]:
            result[i] = GREEN
            remaining[guess[i]] -= 1

    // 2. geçiş: sarılar
    for i in 0..n-1:
        if result[i] != GREEN and remaining[guess[i]] > 0:
            result[i] = YELLOW
            remaining[guess[i]] -= 1

    return result
```

**Birim test vakaları:**

| Gizli | Tahmin | Beklenen |
|---|---|---|
| MASAL | ANLAT | 🟨⬜🟨🟩⬜ |
| MASAL | PRENS | ⬜⬜⬜⬜🟨 |
| MASAL | AAAAA | ⬜🟩⬜🟩⬜ |
| KABAK | KAYAK | 🟩🟩⬜🟩🟩 |
| KABAK | TATLI | ⬜🟩⬜⬜⬜ |

---

## 10. Kenar Durumlar

- **Kaptanın bağlantısı koparsa:** 30 sn beklenir. Dönmezse kelime iptal edilir (can kaybı yok, bulmaca kullanılmış sayılır) ve sıradaki kaptanla yeni kelimeye geçilir.
- **Tahmincinin bağlantısı koparsa:** Onay eşikleri bağlı tahmincilere göre yeniden hesaplanır.
- **Köstebeğin bağlantısı koparsa:** O turda köstebek oylaması yapılmaz.
- **Yeniden bağlanma:** 60 sn içinde dönen oyuncu yerini korur.
- Bağlı oyuncu sayısı 3'ün altına düşerse oyun duraklar.
- Kaptan sırası gelirken bağlı olmayan oyuncular atlanır.
- Aynı anda gelen öneriler ve onaylar sunucuda sırayla işlenir.
- **Hız sınırı:** Bir oyuncu 2 saniyede en fazla 1 öneri yapabilir.
- Host oyunu duraklatabilir; duraklamada tüm sayaçlar durur.

---

## 11. Teknik Öneri

- **Ön yüz:** Next.js, TypeScript, Tailwind CSS
- **Gerçek zamanlı sunucu:** Node.js, TypeScript, Colyseus. **Sunucu otoriterdir:** tüm doğrulama ve renk hesaplama sunucuda yapılır.
- **Veritabanı:** PostgreSQL
- **Veri hazırlama:** Python scriptleri (sözlük temizleme, aile ve bulmaca üretimi → SQL seed)
- **Sayaçlar:** Sunucu her aşama için bir `endsAt` zaman damgası yayınlar; istemci sadece geri sayımı çizer.
- **Ses:** Oyunun içinde yok, Discord kullanılır.

### 11.1 Durum makinesi

```text
LOBBY → WORD_SETUP → SIGNAL ⇄ DISCUSSION → [MOLE_VOTE] → REVEAL → WORD_SETUP … → RUN_END
```

- `SIGNAL`: geçerli sinyal gelince ya da süre dolunca (boş satır) → `DISCUSSION`. Kalan satır 1 ise `SIGNAL` atlanır.
- `DISCUSSION`:
  - doğru tahmin → kelime çözüldü
  - tuzak → kelime başarısız
  - yanlış tahminle satırlar bittiyse → kelime başarısız
  - aşamanın 2. tahmini, pas ya da süre dolması → `SIGNAL`
  - son satırdayken süre dolması → kelime başarısız
- Kelime bitince: Köstebek kartı varsa `MOLE_VOTE`, ardından `REVEAL`.
- `REVEAL` sonrası: can 0 ise `RUN_END`, değilse `WORD_SETUP`.

### 11.2 Mesajlar

**İstemciden sunucuya:**
`join {name}`, `ready`, `start` (host), `reorder {order}` (host), `pause` (host), `skip_reveal` (host), `preview_signal {word}`, `send_signal {word}`, `propose_guess {word}`, `approve {proposalId}`, `propose_pass`, `request_bank_row`, `vote_mole {playerId}`

**Sunucudan istemciye (özel):**
`captain_info {secret, traps, forbidden}`, `mole_info {secret, traps}`, `signal_preview {colors | error}`, `error {code}`

**Hata kodları:**
`WRONG_LENGTH`, `NOT_IN_DICTIONARY`, `FORBIDDEN_LETTER`, `WRONG_CATEGORY`, `ALREADY_USED`, `NOT_ALLOWED_IN_PHASE`, `RATE_LIMITED`

**Ortak durum (herkese):**
`phase`, `endsAt`, `lives`, `bank`, `wordIndex`, `captainId`, `players[]`, `board[] {type: signal|guess|empty, word, colors, byPlayerId}`, `proposals[]`, `wordMeta {length, trapCount, forbiddenCount, rowLimit, chaosCard, category?}`, `score`, `stars`

### 11.3 Veri modeli (taslak)

- `words (id, text, length, freq_rank, categories[], is_profane)`
- `puzzles (id, secret, traps[], forbidden[], tier, approved)`
- `teams (id, name, best_score, best_stars)`
- `runs (id, team_id, started_at, ended_at, score, stars)`
- `run_words (id, run_id, puzzle_id, captain_name, result, rows_used, signals_used, chaos_card)`
- `team_used_puzzles (team_id, puzzle_id)`

`result` değerleri: `solved`, `trap`, `rows`, `cancelled`

---

## 12. Geliştirme Fazları

1. **Faz 1 — Veri:** Sözlük temizleme ve normalizasyon, aile ve bulmaca üretimi, onay için CSV çıktısı. Renk fonksiyonu ve birim testleri (9.4).
2. **Faz 2 — Çekirdek oda:** Lobi, kaptan rotasyonu, sinyal/tartışma döngüsü, öneri ve onay, tuzak, can, satır limiti.
3. **Faz 3 — Hesaplaşma ve dayanıklılık:** Hesaplaşma ekranı, sinyal önizlemesi, kenar durumlar (kopma, yeniden bağlanma).
4. **Faz 4 — İlerleme:** Zorluk eğrisi, kumbara, yıldız, takım rekoru.
5. **Faz 5 — Çeşitlilik ve cila:** Kaos kartları, istatistikler ve ödüller, ses efektleri, animasyonlar.

---

## 13. Config (varsayılan değerler)

Tüm değerler test oyunlarına göre ayarlanacaktır.

```json
{
  "minPlayers": 3,
  "maxPlayers": 8,
  "startLives": 3,
  "maxLives": 3,
  "lifeEverySolved": 5,
  "bankMax": 10,
  "setupSeconds": 5,
  "signalSeconds": 45,
  "discussionSeconds": 90,
  "maxGuessesPerDiscussion": 2,
  "moleVoteSeconds": 30,
  "revealSeconds": 30,
  "captainReconnectSeconds": 30,
  "playerReconnectSeconds": 60,
  "proposalRateLimitMs": 2000,
  "starMaxSignals": 1,
  "commonWordLimit": 20000,
  "chaos": {
    "startWord": 4,
    "every": 3,
    "fastSignalSeconds": 30,
    "fastDiscussionSeconds": 45,
    "moleMinGuessers": 3,
    "categoryMinSignals": 5
  },
  "tiers": [
    { "fromWord": 1,  "lengths": [5],    "trapRange": [1, 1], "rows": 6, "consonantOnly": true  },
    { "fromWord": 4,  "lengths": [5, 6], "trapRange": [1, 1], "rows": 5, "consonantOnly": true  },
    { "fromWord": 7,  "lengths": [6],    "trapRange": [2, 2], "rows": 5, "consonantOnly": false },
    { "fromWord": 10, "lengths": [6, 7], "trapRange": [2, 3], "rows": 4, "consonantOnly": false }
  ]
}
```
