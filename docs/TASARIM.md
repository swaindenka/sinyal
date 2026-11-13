# SİNYAL v2 — Tasarım

> v1'in kuralları (`SINYAL_SPEC.md`) harf renkleri, satırlar, kumbara, kaos ve güç kartları gibi
> üst üste eklenmiş sistemlerle fazla karmaşık hale gelmişti. v2 oyunu sıfırdan, tek bir fikir
> etrafında kurar: **konuşamayan kaptan, elindeki kartlardan biriyle takımı doğru karta yönlendirir.**

## 1. Tasarım hedefleri

1. **Bir dakikada öğrenilir.** Kurallar üç cümleye sığar; ekranda her an tek bir "şimdi ne yapıyorum" cümlesi vardır.
2. **Herkes oynar.** Tahminciler de kendi jetonunu koyar; karar düğme oylamasıyla değil, kartların üstünde birleşen jetonlarla verilir.
3. **Sesli sohbete göre.** Tartışma Discord'da olur; oyun yalnızca kararı ve gerilimi gösterir.
4. **Kısa turlar.** Bir tur 1–2 dakika, bir oyun 10–20 dakika.
5. **Tek ekran.** Tahta ortada, sinyaller üstte, kaptanın eli altta. Kaydırmadan oynanır.

## 2. Kurallar

**Tahta:** Masada 8 kelime kartı vardır. Yalnızca kaptan kartların rolünü görür:

| Rol | Kaptan görür | Açılınca |
|---|---|---|
| **Hedef** (1 kart) | yeşil | İsabet, puan |
| **Parazit** (1–3 kart) | kırmızı | −1 can, tur biter |
| **Boş** (geri kalanlar) | renksiz | Kart kapanır, kaptan yeni sinyal oynar |

**Kaptan** her turda sıradaki oyuncudur. Konuşamaz. Elinde 6 **sinyal kartı** vardır (rastgele kelimeler: KIŞ, TATLI, KORKU, PENGUEN…). Birini seçip oynar; oynanan kartın yerine desteden yenisi gelir. Turda bir kez elini tamamen değiştirebilir.

**Takım** sinyali konuşur ve jetonlarını kartlara koyar. Bütün tahmincilerin jetonu aynı kartta birleşince 3 saniyelik geri sayım başlar; kimse jetonunu çekmezse kart açılır. Jetonlar **Pas** alanında birleşirse kart açılmadan yeni sinyal istenir.

**Sinyal hakkı:** Turda en fazla 3 sinyal oynanır. Hedef 1. sinyalden sonra bulunursa **3 puan**, 2.den sonra **2**, 3.den sonra **1** puan. 3. sinyalden sonra da bulunamazsa sinyal kesilir: **−1 can**.

**Can:** Takım 3 canla başlar. Parazit ya da kesilen sinyal 1 can götürür. Her 5 isabette 1 can geri gelir (en fazla 3). Canlar bitince oyun biter; skor takım adına rekor olarak kaydedilir.

**Süreler:** Kaptanın sinyal seçmesi 45 sn (dolarsa elinden rastgele bir kart oynanır). Takımın karar vermesi 60 sn. Süre dolduğunda en çok jetonun olduğu kart açılır; eşitlik ya da hiç jeton yoksa pas sayılır.

## 3. Zorluk

Tur ilerledikçe parazitler artar ve hedefle **aynı kategoriden** gelmeye başlar (hedef KEDİ ise parazit KÖPEK). Kaptan artık "hayvan" çağrıştırmakla yetinemez, ayırt edici bir kart bulmak zorundadır.

| Seviye | Tur | Parazit | Hedefe yakın parazit | Yakın boş kart | Süreler |
|---|---|---|---|---|---|
| Isınma | 1–3 | 1 | 0 | 0 | 45 / 60 |
| Kolay | 4–6 | 1 | 1 | 0 | 45 / 60 |
| Orta | 7–9 | 2 | 1 | 1 | 45 / 60 |
| Zor | 10–12 | 2 | 2 | 1 | 45 / 50 |
| Usta | 13+ | 3 | 2 | 1 | 35 / 45 |

Bütün sayılar `config/game.json`'dadır.

## 4. Kelime destesi

`data/cards.json`:

- `categories`: tahta kelimeleri, 13 kategoride 521 kelime (hayvan, yiyecek, ev, doğa, taşıt, meslek, giysi, yer, spor, sanat, vücut, teknoloji, masal). Somut, herkesin bildiği, en fazla 10 harfli kelimeler.
- `nitelik`: sinyal elinde kullanılan 106 sıfat (SICAK, SİVRİ, TATLI…). Her elde 2 tane bulunur; çağrışımı esnek tutar.
- `kavram`: 140 soyut ve çok anlamlı kelime (RÜYA, KORKU, GECE…).

Sinyal eli: 2 nitelik + 4 kart (kavram ve bütün kategori kelimeleri). Tahtadaki bir kelimeyle aynı, birini içeren ya da ilk 4 harfi aynı olan kelimeler ele gelmez (KAR ↔ KARPUZ, LİMON ↔ LİMONATA). Aynı kural tahtadaki kartlar arasında da geçerlidir. Bir oyun boyunca tahta kelimeleri tekrarlanmaz (deste bitene kadar).

## 5. Durum makinesi

```
LOBBY → SIGNAL → GUESS ─┬─ hedef ─────────────→ REVEAL → SIGNAL (sonraki tur) … → END
          ↑             ├─ parazit (−1 can) ──→ REVEAL
          │             ├─ boş / pas ──┬─ sinyal hakkı var → SIGNAL
          └─────────────┘              └─ 3 sinyal bitti (−1 can) → REVEAL
```

- REVEAL 6 sn sürer, bütün rolleri gösterir; oda sahibi erken geçebilir.
- Bağlı oyuncu sayısı 2'nin altına düşerse sayaç donar, oyuncu beklenir.
- Kaptan sinyal aşamasında koparsa ve süre dolana kadar dönmezse tur cezasız yenilenir.
- Oyun ortasında gelen oyuncu tahminci olarak katılır, kaptan sırasının sonuna eklenir.

## 6. Kim neyi görür

| Bilgi | Kaptan | Tahminci |
|---|---|---|
| Kartların rolleri | ✓ (özel mesaj) | yalnızca açılan kartlar |
| Kaptanın eli | ✓ (özel mesaj) | kart sayısı |
| Sinyaller, jetonlar, puan, can | ✓ | ✓ |

## 7. v1'den çıkarılanlar

Harf renkleri ve Wordle tahtası, yasak harfler, satır ve kumbara, yıldız, öneri/onay oylaması, kaos kartları, köstebek, güç kartları, boş kart, serbest yazma modu, tepki emojileri. Hepsi tek bir mekaniğe indi: **sinyal kartı + jeton**.
