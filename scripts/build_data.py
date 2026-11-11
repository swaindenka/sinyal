#!/usr/bin/env python3
"""SİNYAL — kelime verisi hazırlama (Faz 1).

Ne yapar:
  1. TDK kelime listesini okur, Türkçe kurallarına göre normalize eder
     (yalın haller, özel isim / kısaltma / çok kelimeli ifadeler çıkarılır).
  2. Küfür/argo listesiyle filtreler.
  3. Her kelimeye sıklık sırası verir (wordfreq, Türkçe).
  4. Yaygın kelimelerden aileleri ve bulmacaları üretir.
  5. Kategori listelerini sözlüğe göre süzer.

Çıktılar (data/ altında):
  words.tsv          KELIME<TAB>sıklık_sırası  (oyunun sözlüğü)
  puzzles.json       Bulmacalar (approved alanıyla)
  puzzles_review.csv Elle onay için CSV
  categories.json    Kategori kilidi kartı için kelimeler
Girdi listeleri: secret_exclude.txt, extra_words.txt, profanity_*.txt, categories_source.json

Kullanım:
  pip install wordfreq
  python3 scripts/build_data.py                 # veriyi üret
  python3 scripts/build_data.py --approvals x.csv  # CSV'deki onayları uygula

Ham kaynaklar data/raw/ altında yoksa indirilir.
"""
from __future__ import annotations

import argparse
import csv
import itertools
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
CONFIG = ROOT / "config" / "game.json"

SOURCES = {
    "tdk_words.txt": "https://raw.githubusercontent.com/mertemin/turkish-word-list/master/words.txt",
    "kufur.txt": "https://raw.githubusercontent.com/ooguz/turkce-kufur-karaliste/master/karaliste.txt",
}

ALPHABET = set("ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ")
VOWELS = set("AEIİOÖUÜ")
MIN_LEN, MAX_LEN = 2, 12
TRAP_COMBOS_PER_SECRET = 2  # her (gizli kelime, tuzak sayısı) için en fazla kaç tuzak seti


def tr_upper(s: str) -> str:
    """toLocaleUpperCase('tr-TR') + şapka sadeleştirme (Â→A, Î→İ, Û→U)."""
    s = s.strip()
    for a, b in (("â", "a"), ("î", "i"), ("û", "u"), ("Â", "A"), ("Î", "İ"), ("Û", "U")):
        s = s.replace(a, b)
    s = s.replace("i", "İ").replace("ı", "I")
    s = s.upper()
    return s.replace("̇", "")


def tr_lower(s: str) -> str:
    return s.replace("İ", "i").replace("I", "ı").lower()


def is_valid(word: str) -> bool:
    return MIN_LEN <= len(word) <= MAX_LEN and all(c in ALPHABET for c in word)


def ensure_raw() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        path = RAW / name
        if not path.exists():
            print(f"indiriliyor: {url}")
            urllib.request.urlretrieve(url, path)


def load_dictionary() -> dict[str, str]:
    """NORMALIZE → orijinal küçük harf yazım (sıklık sorgusu için)."""
    words: dict[str, str] = {}
    for line in (RAW / "tdk_words.txt").read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw:
            continue
        # Özel isimler (büyük harfle başlayan), çok kelimeli ifadeler,
        # kısaltmalar ve ekler çıkarılır.
        if raw[0].isupper() or any(c in raw for c in " -.'’0123456789"):
            continue
        norm = tr_upper(raw)
        if not is_valid(norm):
            continue
        words.setdefault(norm, raw)
    return words


def load_profanity() -> set[str]:
    bad: set[str] = set()
    for path in (RAW / "kufur.txt", DATA / "profanity_extra.txt"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or " " in line:
                continue
            bad.add(tr_upper(line))
    allow_path = DATA / "profanity_allow.txt"
    if allow_path.exists():
        for line in allow_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                bad.discard(tr_upper(line))
    return bad


def frequency_ranks(words: dict[str, str]) -> tuple[dict[str, int], set[str]]:
    """Sıklık sırası (1 = en sık) ve korpusta hiç geçmeyen kelimeler."""
    try:
        from wordfreq import zipf_frequency
    except ImportError:
        sys.exit("wordfreq gerekli: pip install wordfreq")

    freqs = {w: max(zipf_frequency(tr_lower(w), "tr"), zipf_frequency(raw, "tr")) for w, raw in words.items()}
    scored = sorted(words, key=lambda w: (-freqs[w], w))
    return {w: i + 1 for i, w in enumerate(scored)}, {w for w, f in freqs.items() if f <= 0}


def load_word_list(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {tr_upper(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")}


def tier_index(cfg: dict, length: int, trap_count: int, consonant_only: bool, max_rank: int) -> int:
    """Bulmacanın uyduğu en düşük seviye (yoksa -1)."""
    for i, t in enumerate(cfg["tiers"]):
        lo, hi = t["trapRange"]
        if length not in t["lengths"] or not (lo <= trap_count <= hi):
            continue
        if t.get("consonantOnly") and not consonant_only:
            continue
        if max_rank > t.get("maxRank", cfg["commonWordLimit"]):
            continue
        return i
    return -1


def build_puzzles(cfg: dict, common: list[str], ranks: dict[str, int], old_approved: dict[str, bool]) -> list[dict]:
    lengths = {n for t in cfg["tiers"] for n in t["lengths"]}
    max_traps = max(t["trapRange"][1] for t in cfg["tiers"])

    buckets: dict[tuple[str, int], list[str]] = defaultdict(list)
    for word in common:
        if len(word) not in lengths:
            continue
        for i in range(len(word)):
            buckets[(word[:i] + "_" + word[i + 1:], i)].append(word)
    families = {k: sorted(v, key=lambda w: ranks[w]) for k, v in buckets.items() if len(v) >= 2}

    puzzles: dict[str, dict] = {}
    for (pattern, pos), members in families.items():
        for secret in members:
            others = [w for w in members if w != secret]
            for k in range(1, min(max_traps, len(others)) + 1):
                for traps in itertools.islice(itertools.combinations(others, k), TRAP_COMBOS_PER_SECRET):
                    forbidden = [secret[pos]] + [t[pos] for t in traps]
                    consonant_only = all(c not in VOWELS for c in forbidden)
                    max_rank = max(ranks[w] for w in (secret, *traps))
                    tier = tier_index(cfg, len(secret), k, consonant_only, max_rank)
                    if tier < 0:
                        continue
                    pid = f"{secret}:{','.join(traps)}"
                    puzzles[pid] = {
                        "id": pid,
                        "secret": secret,
                        "traps": list(traps),
                        "forbidden": forbidden,
                        "pos": pos,
                        "pattern": pattern,
                        "length": len(secret),
                        "consonantOnly": consonant_only,
                        "rank": max_rank,
                        "tier": tier + 1,
                        "approved": old_approved.get(pid, False),
                    }
    return sorted(puzzles.values(), key=lambda p: (p["tier"], p["rank"], p["id"]))


def build_categories(dictionary: set[str], bad: set[str]) -> dict[str, list[str]]:
    src = json.loads((DATA / "categories_source.json").read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for cat, words in src.items():
        norm = sorted({tr_upper(w) for w in words} & dictionary - bad)
        out[cat] = norm
    return out


def write_csv(puzzles: list[dict]) -> None:
    with (DATA / "puzzles_review.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "secret", "traps", "forbidden", "tier", "rank", "approved"])
        for p in puzzles:
            w.writerow([p["id"], p["secret"], " ".join(p["traps"]), "".join(p["forbidden"]),
                        p["tier"], p["rank"], 1 if p["approved"] else 0])


def apply_approvals(csv_path: Path) -> None:
    puzzles = json.loads((DATA / "puzzles.json").read_text(encoding="utf-8"))
    flags: dict[str, bool] = {}
    with csv_path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            flags[row["id"]] = str(row.get("approved", "")).strip().lower() in ("1", "true", "evet", "e", "x")
    changed = 0
    for p in puzzles:
        if p["id"] in flags and p["approved"] != flags[p["id"]]:
            p["approved"] = flags[p["id"]]
            changed += 1
    (DATA / "puzzles.json").write_text(json.dumps(puzzles, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    write_csv(puzzles)
    total = sum(p["approved"] for p in puzzles)
    print(f"{changed} bulmacanın onayı değişti; toplam onaylı: {total}/{len(puzzles)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--approvals", type=Path, help="Onay sütunu doldurulmuş CSV'yi puzzles.json'a uygula")
    args = ap.parse_args()

    if args.approvals:
        apply_approvals(args.approvals)
        return

    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    ensure_raw()

    words = load_dictionary()
    for w in load_word_list(DATA / "extra_words.txt"):
        if is_valid(w):
            words.setdefault(w, tr_lower(w))
    bad = load_profanity()
    removed = sorted(set(words) & bad)
    for w in removed:
        del words[w]
    print(f"sözlük: {len(words)} kelime ({len(removed)} argo/küfür çıkarıldı)")

    ranks, unseen = frequency_ranks(words)
    with (DATA / "words.tsv").open("w", encoding="utf-8") as f:
        for w in sorted(words, key=lambda x: ranks[x]):
            f.write(f"{w}\t{ranks[w]}\n")

    # Gizli kelime ve tuzaklar yalnızca yaygın kelimelerden seçilir.
    excluded = load_word_list(DATA / "secret_exclude.txt")
    common = [w for w, r in ranks.items()
              if r <= cfg["commonWordLimit"] and w not in unseen and w not in excluded]
    print(f"yaygın kelime: {len(common)}")
    old_path = DATA / "puzzles.json"
    old_approved = {}
    if old_path.exists():
        old_approved = {p["id"]: p["approved"] for p in json.loads(old_path.read_text(encoding="utf-8"))}

    puzzles = build_puzzles(cfg, common, ranks, old_approved)
    old_path.write_text(json.dumps(puzzles, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    write_csv(puzzles)

    by_tier = defaultdict(int)
    secrets_by_tier = defaultdict(set)
    for p in puzzles:
        by_tier[p["tier"]] += 1
        secrets_by_tier[p["tier"]].add(p["secret"])
    for t in sorted(by_tier):
        print(f"seviye {t}: {by_tier[t]} bulmaca, {len(secrets_by_tier[t])} farklı gizli kelime")

    cats = build_categories(set(words), bad)
    (DATA / "categories.json").write_text(json.dumps(cats, ensure_ascii=False, indent=1), encoding="utf-8")
    for c, ws in cats.items():
        print(f"kategori {c}: {len(ws)} kelime")


if __name__ == "__main__":
    main()
