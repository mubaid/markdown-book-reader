#!/usr/bin/env python3
"""Convert a PDF into library/<id>/: book.json, chapter Markdown, cover."""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from importlib.metadata import version as package_version

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.common import chapter_id, clean_text, slugify, write_book  # noqa: E402

HEADING_PATTERN = re.compile(
    r"""(?ix)^(
        (chapter|part|book|volume|section)\s+([0-9]+|[ivxlcdm]+)\b
      | \d+(\.\d+)*\.?\s+[A-Z]
      | (abstract|introduction|background|related\s+work|literature\s+review|
         methods?|methodology|materials\s+and\s+methods|approach|
         results?|experiments?|evaluation|findings|
         discussion|conclusions?|summary|
         references|bibliography|appendix|appendices|
         acknowledg(e)?ments?|limitations|future\s+work)\b
    )"""
)

PAGE_NUMBER = re.compile(r"^(?:[ivxlcdm]{1,7}|\d{1,4}|-\s*\d{1,4}\s*-)$", re.I)
DOTTED_PAGE = re.compile(r"\s+\.{2,}\s*\d+\s*$")
TERMINAL = re.compile(r'[.!?:;)\]}"”’]\s*$')
LIST_START = re.compile(r"^(?:[-•*–—]|\d{1,3}[.)]\s|[a-zA-Z][.)]\s)")


def normalize_repeat(text: str) -> str:
    text = re.sub(r"\d+", "#", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def tidy_title(text: str) -> str:
    text = DOTTED_PAGE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" .·-–—")
    return text or "Untitled"


def span_is_bold(span: dict) -> bool:
    flags = int(span.get("flags", 0))
    font = (span.get("font") or "").lower()
    return bool(flags & 16) or "bold" in font or "black" in font


def block_text(lines: list[dict]) -> tuple[str, float, float]:
    """Join line texts with dehyphenation; return text, max size, bold ratio."""
    parts: list[str] = []
    max_size = 0.0
    bold_chars = 0
    total_chars = 0

    for line in lines:
        spans = line.get("spans") or []
        pieces = []
        line_max = 0.0
        for span in spans:
            chunk = span.get("text") or ""
            pieces.append(chunk)
            size = float(span.get("size") or 0)
            line_max = max(line_max, size)
            chars = len(chunk.strip())
            if chars:
                total_chars += chars
                if span_is_bold(span):
                    bold_chars += chars
        text = "".join(pieces).strip()
        if not text:
            continue
        max_size = max(max_size, line_max)
        if parts and parts[-1].endswith("-") and text[:1].islower():
            parts[-1] = parts[-1][:-1] + text
        else:
            parts.append(text)

    joined = re.sub(r"[ \t]+", " ", " ".join(parts)).strip()
    bold_ratio = bold_chars / total_chars if total_chars else 0.0
    return joined, max_size, bold_ratio


def extract_page_blocks(page: pymupdf.Page) -> list[dict]:
    blocks = []
    data = page.get_text("dict")
    for raw in data.get("blocks", []):
        if raw.get("type") != 0:
            continue
        text, size, bold = block_text(raw.get("lines") or [])
        if not text:
            continue
        x0, y0, x1, y1 = raw.get("bbox", (0, 0, 0, 0))
        blocks.append({
            "page": page.number + 1,
            "text": clean_text(text).strip(),
            "size": size,
            "bold": bold,
            "x0": x0,
            "y0": y0,
            "x1": x1,
            "y1": y1,
            "width": x1 - x0,
        })
    return blocks


def order_blocks(blocks: list[dict], page_width: float) -> list[dict]:
    """Reading order for one- and two-column pages."""
    if not blocks:
        return []

    mid = page_width / 2
    spanning = [b for b in blocks if b["x0"] < mid - 5 < mid + 5 < b["x1"]]
    left = [b for b in blocks if b not in spanning and (b["x0"] + b["x1"]) / 2 < mid]
    right = [b for b in blocks if b not in spanning and (b["x0"] + b["x1"]) / 2 >= mid]

    if len(left) >= 3 and len(right) >= 3:
        ordered = sorted(left, key=lambda b: b["y0"]) + sorted(right, key=lambda b: b["y0"])
        if spanning:
            first_y = min((b["y0"] for b in left + right), default=float("inf"))
            top = [b for b in spanning if b["y0"] <= first_y + 5]
            rest = [b for b in spanning if b not in top]
            ordered = sorted(top, key=lambda b: b["y0"]) + ordered + sorted(rest, key=lambda b: b["y0"])
        return ordered

    return sorted(blocks, key=lambda b: (round(b["y0"], 1), b["x0"]))


def strip_running_lines(pages: list[list[dict]], page_heights: list[float]) -> list[list[dict]]:
    """Remove headers/footers that repeat across pages."""
    total_pages = len(pages)
    counts: Counter[str] = Counter()
    for blocks in pages:
        edge = [b for b in blocks
                if b["y0"] < page_heights[b["page"] - 1] * 0.12
                or b["y1"] > page_heights[b["page"] - 1] * 0.88]
        for block in edge:
            key = normalize_repeat(block["text"])
            if key and len(key) > 2:
                counts[key] += 1

    threshold = max(3, int(total_pages * 0.3))
    repeated = {key for key, count in counts.items() if count >= threshold}

    cleaned = []
    for blocks in pages:
        kept = []
        page_height = page_heights[blocks[0]["page"] - 1] if blocks else 0
        for block in blocks:
            text = block["text"].strip()
            near_edge = block["y0"] < page_height * 0.12 or block["y1"] > page_height * 0.88
            if near_edge:
                short = len(text) <= 90
                all_caps = short and text == text.upper() and any(ch.isalpha() for ch in text)
                has_trailing_number = short and len(text) <= 70 and re.search(r"\d{1,4}\s*$", text)
                if (PAGE_NUMBER.match(text) or normalize_repeat(text) in repeated
                        or all_caps or has_trailing_number):
                    continue
            kept.append(block)
        cleaned.append(kept)
    return cleaned


def should_join_wrapped(previous: dict, current: dict) -> bool:
    """True when two blocks are hard-wrapped lines of the same paragraph."""
    if abs(previous["size"] - current["size"]) > 0.6:
        return False
    text = current["text"].strip()
    if not text or text[0].isupper() or text[0].isdigit():
        return False
    if LIST_START.match(text) or looks_like_heading(text):
        return False
    if TERMINAL.search(previous["text"].strip()):
        return False
    return True


def merge_wrapped_blocks(blocks: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for block in blocks:
        if merged and should_join_wrapped(merged[-1], block):
            previous = merged[-1]
            joiner = "" if previous["text"].endswith("-") else " "
            if joiner == "":
                previous["text"] = previous["text"][:-1] + block["text"].lstrip()
            else:
                previous["text"] = previous["text"].rstrip() + joiner + block["text"].lstrip()
            previous["y1"] = block["y1"]
            continue
        merged.append(dict(block))
    return merged


def body_font_size(pages: list[list[dict]]) -> float:
    weighted: Counter[float] = Counter()
    for blocks in pages:
        for block in blocks:
            if block["size"]:
                weighted[round(block["size"] * 2) / 2] += max(1, len(block["text"]))
    if not weighted:
        return 11.0
    return min(weighted.items(), key=lambda item: (-item[1], item[0]))[0]


def looks_like_heading(text: str) -> bool:
    if not text or len(text) > 120:
        return False
    return bool(HEADING_PATTERN.match(text.strip()))


def is_heading(block: dict, body_size: float) -> bool:
    text = block["text"].strip()
    if not text or len(text) > 140 or "\n" in text:
        return False
    size = block["size"]
    if size >= body_size * 1.28:
        return True
    if size >= body_size * 1.08 and block["bold"] >= 0.45:
        return True
    if looks_like_heading(text) and (size >= body_size * 1.03 or block["bold"] >= 0.6):
        return True
    return False


def toc_chapters(doc: pymupdf.Document) -> list[dict]:
    try:
        toc = doc.get_toc(simple=True)
    except Exception:
        return []

    entries = [(int(level), tidy_title(str(title)), int(page))
               for level, title, page in toc
               if title and str(title).strip() and int(page) >= 1]
    if not entries:
        return []

    level1 = [entry for entry in entries if entry[0] == 1]
    level2 = [entry for entry in entries if entry[0] == 2]
    # Parts + chapters: few level-1 entries and many level-2 entries.
    if level2 and (len(level2) >= len(level1) * 2 or len(level1) < 2) and len(level1) <= 5:
        chosen = level2
    else:
        chosen = level1 or entries

    chosen.sort(key=lambda entry: entry[2])
    chapters = []
    seen_pages = set()
    for _level, title, page in chosen:
        page = min(max(page, 1), doc.page_count)
        if page in seen_pages:
            continue
        seen_pages.add(page)
        chapters.append({"title": title, "page": page})

    if chapters:
        chapters[0]["page"] = 1
    return chapters


def detect_chapters(pages: list[list[dict]], body_size: float) -> list[dict]:
    """Split a page stream at prominent headings."""
    chapters = []
    current = None
    chars_since_break = 0

    for blocks in pages:
        for block in blocks:
            heading = is_heading(block, body_size)
            if heading and (current is None or chars_since_break > 200):
                title = tidy_title(block["text"])
                current = {"title": title, "blocks": []}
                chapters.append(current)
                chars_since_break = 0
                continue
            if current is None:
                current = {"title": "Beginning", "blocks": []}
                chapters.append(current)
            current["blocks"].append(block)
            chars_since_break += len(block["text"])

    return chapters


def render_chapter(title: str, blocks: list[dict], body_size: float, skip_title: bool) -> str:
    lines = [f"# {title}", ""]
    for block in blocks:
        text = block["text"].strip()
        if not text:
            continue
        if skip_title:
            skip_title = False
            if normalize_repeat(text) == normalize_repeat(title):
                continue
        if is_heading(block, body_size) and len(text) <= 140:
            lines.extend([f"## {text}", ""])
        else:
            lines.extend([text, ""])
    return clean_text("\n".join(lines))


def word_count(text: str) -> int:
    return len(re.findall(r"\w+", text))


def merge_short_chapters(chapters: list[dict]) -> list[dict]:
    index = len(chapters) - 1
    while index > 0:
        chapter = chapters[index]
        if word_count(chapter["markdown"]) < 20:
            previous = chapters[index - 1]
            # Drop the merged chapter's own h1 so it doesn't duplicate mid-chapter.
            fragment = re.sub(r"^#[^\n]*\n+", "", chapter["markdown"], count=1)
            previous["markdown"] = clean_text(previous["markdown"] + "\n\n" + fragment)
            chapters.pop(index)
        index -= 1
    return chapters


def render_cover(doc: pymupdf.Document, out_dir: str) -> str | None:
    if doc.page_count == 0:
        return None
    page = doc[0]
    if len(page.get_text().strip()) < 20 and not page.get_images() and doc.page_count > 1:
        page = doc[1]
    zoom = max(1.0, min(2.5, 700 / max(page.rect.width, 1)))
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    filename = "cover.jpg"
    pixmap.save(os.path.join(out_dir, filename), jpg_quality=80)
    return filename


def convert(source: str, out_dir: str, book_identifier: str, source_label: str,
            no_cover: bool) -> dict:
    doc = pymupdf.open(source)
    if doc.page_count == 0:
        raise RuntimeError("PDF has no pages")
    os.makedirs(out_dir, exist_ok=True)

    raw_pages = [extract_page_blocks(page) for page in doc]
    heights = [page.rect.height for page in doc]
    widths = [page.rect.width for page in doc]

    ordered = [order_blocks(blocks, widths[index]) for index, blocks in enumerate(raw_pages)]
    ordered = strip_running_lines(ordered, heights)
    body_size = body_font_size(ordered)
    ordered = [merge_wrapped_blocks(page) for page in ordered]

    chapters_meta = toc_chapters(doc)
    extracted: list[dict] = []

    if len(chapters_meta) >= 2:
        starts = chapters_meta
        for index, entry in enumerate(starts):
            start = entry["page"]
            end = starts[index + 1]["page"] if index + 1 < len(starts) else doc.page_count + 1
            blocks = [block for page in range(start, end) for block in ordered[page - 1]]
            markdown = render_chapter(entry["title"], blocks, body_size, skip_title=True)
            extracted.append({"title": entry["title"], "page": start, "markdown": markdown})
    else:
        detected = detect_chapters(ordered, body_size)
        if len(detected) < 2:
            blocks = [block for page in ordered for block in page]
            title = tidy_title(doc.metadata.get("title") or slugify(os.path.basename(source)))
            extracted = [{"title": title, "page": 1,
                          "markdown": render_chapter(title, blocks, body_size, skip_title=False)}]
        else:
            for chapter in detected:
                first_page = chapter["blocks"][0]["page"] if chapter["blocks"] else 1
                extracted.append({
                    "title": chapter["title"],
                    "page": first_page,
                    "markdown": render_chapter(chapter["title"], chapter["blocks"], body_size,
                                               skip_title=True),
                })

    extracted = merge_short_chapters(extracted)

    used_ids: set[str] = set()
    chapters = []
    for index, chapter in enumerate(extracted):
        chap_id = chapter_id(index, chapter["title"], used_ids)
        filename = chap_id + ".md"
        with open(os.path.join(out_dir, filename), "w", encoding="utf-8") as handle:
            handle.write(chapter["markdown"])
        chapters.append({
            "id": chap_id,
            "title": chapter["title"],
            "file": filename,
            "page": chapter["page"],
        })

    cover = None if no_cover else render_cover(doc, out_dir)

    metadata = doc.metadata or {}
    year_match = re.search(r"\b(\d{4})\b", str(metadata.get("creationDate") or ""))
    author = (metadata.get("author") or "").strip()
    title = tidy_title(metadata.get("title") or slugify(os.path.basename(source)))

    payload = {
        "id": book_identifier,
        "title": title,
        "authors": [author] if author else [],
        "year": int(year_match.group(1)) if year_match else None,
        "language": "und",
        "source": {"file": source_label, "type": "pdf"},
        "cover": cover,
        "chapters": chapters,
        "convertedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "converter": f"pymupdf-{package_version('pymupdf')}",
    }
    write_book(out_dir, payload)
    doc.close()
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF into Markdown chapters.")
    parser.add_argument("source", help="path to the .pdf file")
    parser.add_argument("--out", required=True, help="output directory, e.g. library/my-book")
    parser.add_argument("--id", required=True, help="book identifier used by the server")
    parser.add_argument("--source-file", default="", help="label stored in book.json source.file")
    parser.add_argument("--force", action="store_true", help="accepted for CLI symmetry")
    parser.add_argument("--no-images", action="store_true", help="accepted; PDF images are not extracted")
    parser.add_argument("--no-cover", action="store_true", help="skip cover rendering")
    args = parser.parse_args()

    source_label = args.source_file or os.path.basename(args.source)
    try:
        book = convert(args.source, args.out, args.id, source_label, args.no_cover)
    except Exception as error:  # noqa: BLE001 - CLI boundary
        print(f"error: {args.source}: {error}", file=sys.stderr)
        return 1

    print(f"converted {book['title']!r}: {len(book['chapters'])} chapters -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
