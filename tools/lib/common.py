"""Shared helpers for the EPUB and PDF converters."""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata

LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
}

IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
}

IMAGE_EXT_BY_SUFFIX = {
    ".jpg": ".jpg",
    ".jpeg": ".jpg",
    ".png": ".png",
    ".gif": ".gif",
    ".webp": ".webp",
    ".svg": ".svg",
    ".avif": ".avif",
    ".bmp": ".bmp",
}


def slugify(text: str, fallback: str = "chapter") -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)[:60].strip("-")
    return text or fallback


def unique_name(base: str, used: set[str]) -> str:
    name = base
    counter = 2
    while name in used:
        name = f"{base}-{counter}"
        counter += 1
    used.add(name)
    return name


def chapter_id(index: int, title: str, used_ids: set[str]) -> str:
    base = f"{index:02d}-{slugify(title)}"
    return unique_name(base, used_ids)


def clean_text(text: str) -> str:
    """Normalize typography without destroying Markdown structure."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    for bad, good in LIGATURES.items():
        text = text.replace(bad, good)
    text = text.replace("\u00ad", "").replace("\u00a0", " ")

    lines = [line.rstrip() for line in text.splitlines()]
    out: list[str] = []
    for line in lines:
        if line == "" and out and out[-1] == "":
            continue
        out.append(line)
    return "\n".join(out).strip() + "\n"


_JUNK_LINE = re.compile(
    r"^\s*#?\s*chapter\s*\d+\s*#?\s*$|✨|^\s*to\s*be\s*continu",
    re.I,
)
# Broken Arabic honorific glued into Roman Urdu text (bidi-mangled "sallallahu alaihi wasallam")
_HONORIFIC = re.compile(r"\s*و?س?ل?م?\s*عل[یي]ہ\s*[هہ]?ل?ل?ا?\s*صلی\s*")
_LIST_ITEM = re.compile(r"^\s*(\d+\.|[-*•])\s")
_SETEXT_UNDERLINE = re.compile(r"^\s*(?:={2,}|-{2,})\s*$")


def _reflow_dialogue(text: str) -> str:
    """Start a new paragraph for each fresh quoted utterance."""
    return re.sub(r'(?<=[.!?"\'])\s+(?=[""''"])', "\n\n", text)


def _is_structured_line(line: str) -> bool:
    """Lines that must keep their own line breaks: headings, lists, images,
    blockquotes, table rows, and indented code."""
    stripped = line.lstrip()
    return bool(
        stripped.startswith(("#", ">", "|"))
        or line.startswith(("    ", "\t"))
        or _LIST_ITEM.match(line)
        or "![" in line
    )


def tidy_markdown(md: str) -> str:
    """Readability pass: strip decorative junk, unwrap hard-wrapped paragraphs,
    reflow dialogue, normalize punctuation and honorifics.

    Code fences, tables, blockquotes, lists, and indented code are preserved
    verbatim; only plain prose paragraphs are reflowed.
    """
    if not md:
        return md
    md = _HONORIFIC.sub(" ﷺ ", md)

    # Drop junk lines, but never inside code fences.
    filtered: list[str] = []
    in_fence = False
    for line in md.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            filtered.append(line)
            continue
        if not in_fence and _JUNK_LINE.search(line) and not line.lstrip().startswith("# "):
            continue
        filtered.append(line)

    segments: list[str] = []
    run: list[str] = []      # prose lines of the paragraph being reflowed
    struct: list[str] = []   # contiguous structured lines kept verbatim
    in_fence = False

    def flush_run():
        if run:
            joined = re.sub(r" {2,}", " ", " ".join(s.strip() for s in run if s.strip()))
            joined = re.sub(r"([A-Za-z]),(?=[A-Za-z])", r"\1, ", joined)
            joined = re.sub(r"(?<!\.)\.\.(?!\.)", ".", joined)
            segments.append(_reflow_dialogue(joined))
            run.clear()

    def flush_struct():
        if struct:
            segments.append("\n".join(struct))
            struct.clear()

    for line in filtered:
        if line.lstrip().startswith(("```", "~~~")):
            flush_run()
            struct.append(line)
            in_fence = not in_fence
            if not in_fence:
                flush_struct()
            continue
        if in_fence:
            struct.append(line)
            continue
        if not line.strip():
            flush_run()
            flush_struct()
            continue
        if _is_structured_line(line) or (_SETEXT_UNDERLINE.match(line) and run):
            flush_run()
            struct.append(line)
            continue
        if struct and line.startswith(("  ", "\t")):
            # indented continuation of a list item / blockquote
            struct.append(line)
            continue
        flush_struct()
        run.append(line)
    flush_run()
    flush_struct()

    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(s for s in segments if s.strip())).strip() + "\n"


def write_book(out_dir: str, book: dict) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "book.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(book, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)
    return path


def image_extension(content_type: str = "", name_hint: str = "") -> str:
    hint_path = (name_hint or "").split("?")[0].split("#")[0]
    suffix = os.path.splitext(hint_path)[1].lower()
    ext = IMAGE_EXTENSIONS.get((content_type or "").split(";")[0].strip().lower())
    return ext or IMAGE_EXT_BY_SUFFIX.get(suffix, ".jpg")


def save_image(
    data: bytes,
    assets_dir: str,
    name_hint: str = "",
    content_type: str = "",
    prefix: str = "",
) -> str:
    """Write image bytes into assets/ (deduped by content) and return its relative path."""
    hint_path = (name_hint or "").split("?")[0].split("#")[0]
    ext = image_extension(content_type, name_hint)

    digest = hashlib.sha1(data).hexdigest()[:10]
    stem = slugify(os.path.splitext(os.path.basename(hint_path))[0], "image")[:40]
    filename = f"{prefix}{stem}-{digest}{ext}"

    os.makedirs(assets_dir, exist_ok=True)
    target = os.path.join(assets_dir, filename)
    if not os.path.exists(target):
        with open(target, "wb") as handle:
            handle.write(data)
    return f"assets/{filename}"
