#!/usr/bin/env python3
"""Convert native Markdown novels into library/<id>/.

Two source layouts:
  - a single .md file: chapters are split on its headings
  - a folder of .md files: each file is one chapter, sorted naturally

Front matter is optional; recognized keys: title, book_title, author(s), year/date,
language, cover.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.common import (  # noqa: E402
    clean_text,
    image_extension,
    save_image,
    slugify,
    write_book,
)

HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
IMAGE_RE = re.compile(
    r"!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)"
)
LINK_RE = re.compile(
    r"(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(\s+[\"'][^\"']*[\"'])?\s*\)"
)
FRONT_BY_RE = re.compile(r"^\s*(?:by|author(?:s)?\s*:)\s+(.+?)\s*$", re.I)
TITLE_BY_RE = re.compile(r"^(.*?)\s+[-–—]\s+(?:by|written\s+by)\s+(.+)$", re.I)
TRANSLATOR_RE = re.compile(r"[\s,;]*(?:translat(?:ed|ion)\s+by\b|translated\b).*$", re.I)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".bmp"}


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
        text = handle.read()
    return text.replace("\r\n", "\n").replace("\r", "\n")


def unquote_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def split_front_matter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    lines = text.split("\n")
    end = None
    for index in range(1, min(len(lines), 80)):
        if lines[index].strip() in ("---", "..."):
            end = index
            break
    if end is None:
        return {}, text

    meta: dict = {}
    list_key = None
    for raw in lines[1:end]:
        if not raw.strip():
            continue
        item = re.match(r"^\s*-\s+(.+)$", raw)
        if item and list_key:
            meta.setdefault(list_key, []).append(unquote_scalar(item.group(1)))
            continue
        match = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", raw)
        if not match:
            list_key = None
            continue
        key = match.group(1).lower()
        value = match.group(2).strip()
        if value == "":
            meta[key] = []
            list_key = key
        elif value.startswith("[") and value.endswith("]"):
            meta[key] = [unquote_scalar(part) for part in value[1:-1].split(",") if part.strip()]
            list_key = None
        else:
            meta[key] = unquote_scalar(value)
            list_key = None

    body = "\n".join(lines[end + 1:]).lstrip("\n")
    return meta, body


def clean_heading(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`~]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def humanize_name(name: str) -> str:
    name = os.path.splitext(os.path.basename(name))[0]
    name = re.sub(r"[_]+", " ", name)
    name = re.sub(r"-+", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    if name and name.islower():
        name = name.title()
    return name or "Untitled"


def natural_key(name: str):
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", name)]


def scan_headings(text: str) -> list[dict]:
    headings = []
    in_fence = False
    offset = 0
    for line in text.split("\n"):
        if FENCE_RE.match(line):
            in_fence = not in_fence
        elif not in_fence:
            match = HEADING_RE.match(line)
            if match:
                title = clean_heading(match.group(2))
                if title:
                    headings.append({
                        "level": len(match.group(1)),
                        "title": title,
                        "start": offset,
                        "end": offset + len(line),
                    })
        offset += len(line) + 1
    return headings


def front_matter_chapter(text: str) -> str:
    cleaned = re.sub(r"^#{1,3}[ \t]+.*$", "", text, flags=re.M)
    return cleaned.strip()


def split_single_file(text: str, fallback_title: str) -> tuple[list[dict], str]:
    headings = scan_headings(text)
    h1 = [heading for heading in headings if heading["level"] == 1]
    h2 = [heading for heading in headings if heading["level"] == 2]

    level = None
    book_title = None
    if len(h1) == 1 and len(h2) >= 2:
        level = 2
        book_title = h1[0]["title"]
    elif len(h1) >= 2:
        level = 1
    elif len(h2) >= 2:
        level = 2
    elif h1:
        level = 1
    elif h2:
        level = 2

    if level is None:
        return [{"title": fallback_title, "content": text.strip()}], book_title

    selected = [heading for heading in headings if heading["level"] == level]
    before = text[:selected[0]["start"]]
    chapters = []

    front = front_matter_chapter(before)
    if len(front.split()) >= 40:
        chapters.append({"title": "Front Matter", "content": front})

    for index, heading in enumerate(selected):
        end = selected[index + 1]["start"] if index + 1 < len(selected) else len(text)
        content = text[heading["end"]:end].strip("\n")
        if not content.strip():
            continue
        chapters.append({"title": heading["title"], "content": content})

    if not chapters:
        chapters = [{"title": fallback_title, "content": text.strip()}]
    return chapters, book_title


def first_heading(title_text: str) -> str | None:
    for heading in scan_headings(title_text):
        if heading["level"] <= 2:
            return heading["title"]
    return None


def first_md_heading(content: str) -> str | None:
    return first_heading(content)


def process_assets(content: str, base_dir: str, assets_dir: str, no_images: bool,
                   link_map: dict[str, str] | None = None) -> str:
    def image_replacer(match: re.Match) -> str:
        alt, url = match.group(1), match.group(2)
        if no_images:
            return alt
        if url.startswith(("http://", "https://", "data:", "//")):
            return match.group(0)
        relative = unquote(url).split("#")[0].split("?")[0]
        source_path = os.path.normpath(os.path.join(base_dir, relative))
        if not os.path.isfile(source_path):
            return match.group(0)
        try:
            with open(source_path, "rb") as handle:
                data = handle.read()
        except OSError:
            return match.group(0)
        saved = save_image(data, assets_dir, os.path.basename(relative))
        return f"![{alt}]({saved})"

    content = IMAGE_RE.sub(image_replacer, content)

    if link_map:
        def link_replacer(match: re.Match) -> str:
            label, url, title = match.group(1), match.group(2), match.group(3) or ""
            if url.startswith(("http://", "https://", "mailto:", "tel:", "#", "//")):
                return match.group(0)
            path, _sep, fragment = url.partition("#")
            if not path.lower().endswith(".md"):
                return match.group(0)
            key = os.path.normpath(os.path.join(base_dir, unquote(path)))
            target = link_map.get(key) or link_map.get(os.path.basename(path))
            if not target:
                return match.group(0)
            new_url = target + ("#" + fragment if fragment else "")
            return f"[{label}]({new_url}{title})"

        content = LINK_RE.sub(link_replacer, content)
    return content


def ensure_title_heading(content: str, title: str) -> str:
    """Give every chapter an h1, promoting a matching h2 instead of duplicating it."""
    headings = scan_headings(content)
    if any(heading["level"] == 1 for heading in headings):
        return content
    first = headings[0] if headings else None
    if first and first["level"] == 2 and first["title"] == title:
        line = content[first["start"]:first["end"]]
        promoted = re.sub(r"^#{2,6}\s+", "# ", line, count=1)
        return content[:first["start"]] + promoted + content[first["end"]:]
    return f"# {title}\n\n{content}"


def find_cover(source: str, meta: dict, is_dir: bool) -> str | None:
    base_dir = source if is_dir else os.path.dirname(source) or "."
    candidates = []
    explicit = meta.get("cover")
    if isinstance(explicit, str) and explicit:
        candidates.append(os.path.join(base_dir, unquote(explicit)))
    if is_dir:
        candidates.extend(os.path.join(base_dir, "cover" + ext) for ext in sorted(IMAGE_SUFFIXES))
    else:
        stem = os.path.splitext(os.path.basename(source))[0]
        candidates.extend(os.path.join(base_dir, stem + ext) for ext in sorted(IMAGE_SUFFIXES))
        candidates.extend(os.path.join(base_dir, "cover" + ext) for ext in sorted(IMAGE_SUFFIXES))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def collect_authors(meta: dict) -> list[str]:
    authors: list[str] = []
    raw = meta.get("authors", meta.get("author"))
    if isinstance(raw, list):
        authors.extend(str(item).strip() for item in raw if str(item).strip())
    elif isinstance(raw, str) and raw.strip():
        authors.extend(part.strip() for part in re.split(r"\s*[;,]\s*", raw) if part.strip())
    return authors


def split_title_byline(title: str) -> tuple[str, list[str]]:
    """Turn "Title - By Author, Translator" into a clean title and author list."""
    match = TITLE_BY_RE.match(title.strip())
    if not match:
        return title, []
    clean = match.group(1).strip(" -–—")
    byline = TRANSLATOR_RE.sub("", match.group(2)).strip(" ,;")
    authors = [part.strip() for part in re.split(r"\s*[;,]\s*", byline) if part.strip()]
    return clean or title, authors


def book_year(meta: dict) -> int | None:
    raw = meta.get("year", meta.get("date", ""))
    match = re.search(r"\b(\d{4})\b", str(raw))
    return int(match.group(1)) if match else None


def convert_single_file(source: str, out_dir: str, book_identifier: str, source_label: str,
                        no_images: bool, no_cover: bool) -> dict:
    text = read_text(source)
    meta, body = split_front_matter(text)
    base_dir = os.path.dirname(os.path.abspath(source))
    fallback = humanize_name(source)

    chapters, h1_title = split_single_file(body, fallback)
    explicit_title = meta.get("book_title") or meta.get("title")
    title = str(explicit_title or h1_title or fallback).strip()

    authors = collect_authors(meta)
    if not explicit_title:
        title, byline_authors = split_title_byline(title)
        if not authors:
            authors = byline_authors
    if not authors:
        prefix = body[:2000]
        for line in prefix.split("\n")[:20]:
            match = FRONT_BY_RE.match(line)
            if match:
                authors = [match.group(1).strip()]
                break

    assets_dir = os.path.join(out_dir, "assets")
    used = set()
    chapter_entries = []
    for index, chapter in enumerate(chapters):
        content = chapter["content"].strip()
        if not content:
            continue
        content = process_assets(content, base_dir, assets_dir, no_images)
        content = ensure_title_heading(content, chapter["title"])
        chapter_id = f"{index:02d}-{slugify(chapter['title'])}"
        base_id = chapter_id
        counter = 2
        while chapter_id in used:
            chapter_id = f"{base_id}-{counter}"
            counter += 1
        used.add(chapter_id)
        filename = chapter_id + ".md"
        with open(os.path.join(out_dir, filename), "w", encoding="utf-8") as handle:
            handle.write(clean_text(content))
        chapter_entries.append({"id": chapter_id, "title": chapter["title"], "file": filename})

    if not chapter_entries:
        raise RuntimeError("no readable chapters found")

    cover = None
    if not no_cover:
        cover_source = find_cover(source, meta, is_dir=False)
        if cover_source:
            with open(cover_source, "rb") as handle:
                data = handle.read()
            ext = image_extension("", cover_source)
            cover = "cover" + ext
            with open(os.path.join(out_dir, cover), "wb") as handle:
                handle.write(data)

    payload = {
        "id": book_identifier,
        "title": title,
        "authors": authors,
        "year": book_year(meta),
        "language": str(meta.get("language") or "und"),
        "source": {"file": source_label, "type": "markdown"},
        "cover": cover,
        "chapters": chapter_entries,
        "convertedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "converter": "native-markdown",
    }
    write_book(out_dir, payload)
    return payload


def convert_folder(source: str, out_dir: str, book_identifier: str, source_label: str,
                   no_images: bool, no_cover: bool) -> dict:
    files = sorted(
        (entry for entry in os.listdir(source)
         if entry.lower().endswith(".md") and not entry.startswith(".")),
        key=natural_key,
    )
    if not files:
        raise RuntimeError("folder contains no .md files")

    base_dir = os.path.abspath(source)
    parsed = []
    first_meta: dict = {}
    for name in files:
        path = os.path.join(base_dir, name)
        meta, body = split_front_matter(read_text(path))
        if not first_meta:
            first_meta = meta
        elif not first_meta.get("authors") and not first_meta.get("author"):
            for key in ("authors", "author", "year", "date", "language"):
                if meta.get(key):
                    first_meta[key] = meta[key]
        parsed.append({"path": path, "name": name, "meta": meta, "body": body})

    # Assign chapter IDs first so cross-file links can be rewritten.
    used = set()
    chapters = []
    link_map: dict[str, str] = {}
    for index, entry in enumerate(parsed):
        meta = entry["meta"]
        title = str(meta.get("title") or "").strip()
        if not title:
            title = first_md_heading(entry["body"]) or humanize_name(entry["name"])
        chapter_id = f"{index:02d}-{slugify(title)}"
        base_id = chapter_id
        counter = 2
        while chapter_id in used:
            chapter_id = f"{base_id}-{counter}"
            counter += 1
        used.add(chapter_id)
        entry["title"] = title
        entry["id"] = chapter_id
        link_map[os.path.normpath(entry["path"])] = chapter_id
        link_map[entry["name"]] = chapter_id
        chapters.append(entry)

    assets_dir = os.path.join(out_dir, "assets")
    chapter_entries = []
    for entry in chapters:
        content = entry["body"].strip()
        if not content:
            continue
        content = process_assets(content, base_dir, assets_dir, no_images, link_map)
        content = ensure_title_heading(content, entry["title"])
        filename = entry["id"] + ".md"
        with open(os.path.join(out_dir, filename), "w", encoding="utf-8") as handle:
            handle.write(clean_text(content))
        chapter_entries.append({
            "id": entry["id"],
            "title": entry["title"],
            "file": filename,
        })

    if not chapter_entries:
        raise RuntimeError("all .md files in the folder are empty")

    title = str(first_meta.get("book_title") or humanize_name(source)).strip()
    authors = collect_authors(first_meta)

    cover = None
    if not no_cover:
        cover_source = find_cover(source, first_meta, is_dir=True)
        if cover_source:
            with open(cover_source, "rb") as handle:
                data = handle.read()
            ext = image_extension("", cover_source)
            cover = "cover" + ext
            with open(os.path.join(out_dir, cover), "wb") as handle:
                handle.write(data)

    payload = {
        "id": book_identifier,
        "title": title,
        "authors": authors,
        "year": book_year(first_meta),
        "language": str(first_meta.get("language") or "und"),
        "source": {"file": source_label, "type": "markdown"},
        "cover": cover,
        "chapters": chapter_entries,
        "convertedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "converter": "native-markdown",
    }
    write_book(out_dir, payload)
    return payload


def convert(source: str, out_dir: str, book_identifier: str, source_label: str,
            no_images: bool, no_cover: bool) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    if os.path.isdir(source):
        return convert_folder(source, out_dir, book_identifier, source_label, no_images, no_cover)
    return convert_single_file(source, out_dir, book_identifier, source_label, no_images, no_cover)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a Markdown novel into chapter files.")
    parser.add_argument("source", help="path to a .md file or a folder of .md chapters")
    parser.add_argument("--out", required=True, help="output directory, e.g. library/my-book")
    parser.add_argument("--id", required=True, help="book identifier used by the server")
    parser.add_argument("--source-file", default="", help="label stored in book.json source.file")
    parser.add_argument("--force", action="store_true", help="accepted for CLI symmetry")
    parser.add_argument("--no-images", action="store_true", help="do not copy local images")
    parser.add_argument("--no-cover", action="store_true", help="skip cover detection")
    args = parser.parse_args()

    source_label = args.source_file or os.path.basename(os.path.normpath(args.source))
    try:
        book = convert(args.source, args.out, args.id, source_label,
                       args.no_images, args.no_cover)
    except Exception as error:  # noqa: BLE001 - CLI boundary
        print(f"error: {args.source}: {error}", file=sys.stderr)
        return 1

    print(f"converted {book['title']!r}: {len(book['chapters'])} chapters -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
