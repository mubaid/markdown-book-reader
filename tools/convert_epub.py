#!/usr/bin/env python3
"""Convert an EPUB into library/<id>/: book.json, chapter Markdown, cover, images."""

from __future__ import annotations

import argparse
import base64
import os
import posixpath
import re
import sys
import warnings
from datetime import datetime, timezone
from importlib.metadata import version as package_version
from urllib.parse import unquote

import ebooklib
import markdownify as markdownify_module
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
from ebooklib import epub

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.common import (  # noqa: E402
    chapter_id,
    clean_text,
    image_extension,
    save_image,
    slugify,
    tidy_markdown,
    write_book,
)


def first_meta(book: epub.EpubBook, namespace: str, name: str, default: str = "") -> str:
    values = book.get_metadata(namespace, name)
    if not values:
        return default
    return str(values[0][0] or default).strip()


def all_meta(book: epub.EpubBook, namespace: str, name: str) -> list[str]:
    return [str(value).strip() for value, _attrs in book.get_metadata(namespace, name) if value]


def normalize_href(href: str) -> str:
    href = unquote(href or "")
    return posixpath.normpath(href.split("#")[0].split("?")[0]).lstrip("./")


def build_toc_map(book: epub.EpubBook) -> dict[str, str]:
    """Map document path -> chapter title using the EPUB nav/TOC."""
    toc = book.toc
    entries = list(toc) if not isinstance(toc, list) else toc
    mapping: dict[str, str] = {}

    def walk(items, inherited: str | None = None) -> None:
        for entry in items:
            if isinstance(entry, tuple):
                section, children = entry
                title = (getattr(section, "title", None) or inherited or "").strip()
                href = getattr(section, "href", None)
                if href and title:
                    mapping.setdefault(normalize_href(href), title)
                walk(children, title)
                continue

            title = (getattr(entry, "title", None) or inherited or "").strip()
            href = getattr(entry, "href", None)
            if href and title:
                mapping.setdefault(normalize_href(href), title)

    walk(entries)
    return mapping


def resolve_item(book: epub.EpubBook, base_name: str, href: str):
    """Find the manifest item an href points at, relative to the current document."""
    path = unquote((href or "").split("#")[0].split("?")[0])
    if not path or path.startswith("data:"):
        return None

    candidates = [
        posixpath.normpath(posixpath.join(posixpath.dirname(base_name), path)),
        posixpath.normpath(path),
    ]
    for candidate in candidates:
        item = book.get_item_with_href(candidate)
        if item is not None:
            return item

    basename = posixpath.basename(path)
    for item in book.get_items():
        name = item.get_name() or ""
        if name == basename or name.endswith("/" + basename):
            return item
    return None


def is_image_data(data: bytes, media_type: str = "") -> bool:
    """True when the bytes really are an image (some EPUBs mark an XHTML
    cover *page* as the cover item instead of the cover image)."""
    if (media_type or "").lower().startswith("image/"):
        return True
    head = bytes(data[:16])
    return (
        head.startswith((b"\xff\xd8", b"\x89PNG", b"GIF8", b"BM", b"\x00\x00\x01\x00"))
        or (head.startswith(b"RIFF") and head[8:12] == b"WEBP")
        or head[4:12] in (b"ftypavif", b"ftypavis")
        or b"<svg" in bytes(data[:512]).lower()
    )


def extract_cover(book: epub.EpubBook, out_dir: str) -> str | None:
    candidates = list(book.get_items_of_type(ebooklib.ITEM_COVER))

    for value, _attrs in book.get_metadata("OPF", "cover"):
        if value:
            item = book.get_item_with_id(str(value))
            if item is not None:
                candidates.append(item)
            break

    for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
        blob = f"{item.id} {item.get_name()}".lower()
        if "cover" in blob:
            candidates.append(item)
            break

    for cover in candidates:
        data = cover.get_content()
        if not isinstance(data, (bytes, bytearray)):
            continue
        if not is_image_data(data, getattr(cover, "media_type", "") or ""):
            continue
        ext = image_extension(getattr(cover, "media_type", "") or "", cover.get_name() or "")
        filename = f"cover{ext}"
        with open(os.path.join(out_dir, filename), "wb") as handle:
            handle.write(data)
        return filename
    return None


def data_uri_bytes(src: str) -> bytes | None:
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", src, re.S)
    if not match:
        return None
    payload = match.group(3)
    if match.group(2):
        try:
            return base64.b64decode(payload)
        except (ValueError, TypeError):
            return None
    return unquote(payload).encode("utf-8")


def convert(source: str, out_dir: str, book_identifier: str, source_label: str,
            no_images: bool, no_cover: bool) -> dict:
    book = epub.read_epub(source)
    os.makedirs(out_dir, exist_ok=True)
    assets_dir = os.path.join(out_dir, "assets")

    toc_map = build_toc_map(book)
    spine_items: list = []
    seen_ids: set[str] = set()
    for idref, linear in book.spine:
        if linear == "no" or idref in seen_ids:
            continue
        item = book.get_item_with_id(idref)
        if item is None or isinstance(item, epub.EpubNav):
            continue
        if item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        name = (item.get_name() or "").lower()
        if not name.endswith((".xhtml", ".html", ".htm")):
            continue
        spine_items.append(item)
        seen_ids.add(idref)

    if not spine_items:
        raise RuntimeError("no readable spine documents found")

    # Pass 1: assign chapter titles and stable filenames/ids.
    used_ids: set[str] = set()
    chapter_records = []
    for index, item in enumerate(spine_items):
        name = item.get_name() or ""
        soup = BeautifulSoup(item.get_content(), "lxml")
        for bad in soup(["script", "style", "noscript"]):
            bad.decompose()
        heading = soup.find(["h1", "h2"])
        heading_text = heading.get_text(" ", strip=True) if heading else ""
        words = len(soup.get_text(" ", strip=True).split())
        title = (toc_map.get(normalize_href(name)) or heading_text
                 or os.path.splitext(posixpath.basename(name))[0] or f"Chapter {index + 1}")
        title = re.sub(r"\s+", " ", title).strip()
        chapter_records.append({
            "item": item,
            "title": title,
            "words": words,
            "has_heading": heading is not None,
        })

    # Drop tiny spine documents (ads, image-only pages) unless nothing else remains.
    substantial = [r for r in chapter_records if r["words"] >= 25 or r["has_heading"]]
    if substantial:
        chapter_records = substantial

    item_to_chapter: dict[str, str] = {}
    for index, record in enumerate(chapter_records):
        chap_id = chapter_id(index, record["title"], used_ids)
        record["id"] = chap_id
        item_to_chapter[record["item"].get_name() or ""] = chap_id

    # Pass 2: convert each document to Markdown.
    chapters = []
    for record in chapter_records:
        item = record["item"]
        base_name = item.get_name() or ""
        soup = BeautifulSoup(item.get_content(), "lxml")
        for bad in soup(["script", "style", "noscript"]):
            bad.decompose()
        for nav in soup.select("nav"):
            nav.decompose()
        body = soup.body or soup
        for heading in body.find_all(["h1", "h2", "h3"]):
            for link in heading.find_all("a"):
                link.replace_with_children()
        if body.find("h1") is None:
            first_h2 = body.find("h2")
            if first_h2 is not None:
                first_h2.name = "h1"

        for image in list(body.find_all("img")):
            if no_images:
                image.decompose()
                continue
            src = image.get("src") or ""
            if not src:
                image.decompose()
                continue

            if src.startswith("data:"):
                data = data_uri_bytes(src)
                if not data:
                    image.decompose()
                    continue
                image["src"] = save_image(data, assets_dir, "inline-image", "", "")
                continue

            target = resolve_item(book, base_name, src)
            if target is None:
                image.decompose()
                continue
            content = target.get_content()
            if not isinstance(content, (bytes, bytearray)):
                image.decompose()
                continue
            image["src"] = save_image(
                content,
                assets_dir,
                target.get_name() or src,
                getattr(target, "media_type", "") or "",
            )

        for anchor in body.find_all("a"):
            href = anchor.get("href") or ""
            if not href or href.startswith(("#", "http://", "https://", "mailto:", "tel:", "//")):
                continue
            path, _sep, fragment = href.partition("#")
            target = resolve_item(book, base_name, path)
            if target is None:
                continue
            target_id = item_to_chapter.get(target.get_name() or "")
            if not target_id:
                continue
            if target.get_name() == base_name:
                anchor["href"] = "#" + fragment if fragment else "#"
                continue
            anchor["href"] = target_id + ("#" + fragment if fragment else "")

        markdown = markdownify_module.markdownify(
            str(body), heading_style="ATX", bullets="-", strip=["script", "style"]
        )
        markdown = clean_text(markdown)
        markdown = tidy_markdown(markdown)
        if not body.find("h1"):
            markdown = f"# {record['title']}\n\n{markdown}"

        filename = record["id"] + ".md"
        with open(os.path.join(out_dir, filename), "w", encoding="utf-8") as handle:
            handle.write(markdown)

        chapters.append({
            "id": record["id"],
            "title": record["title"],
            "file": filename,
        })

    cover = None if no_cover else extract_cover(book, out_dir)

    date_raw = first_meta(book, "DC", "date")
    year_match = re.search(r"\b(\d{4})\b", date_raw)
    authors = all_meta(book, "DC", "creator")
    if not authors:
        author = first_meta(book, "DC", "creator")
        if author:
            authors = [author]

    title = first_meta(book, "DC", "title") or slugify(os.path.basename(source))

    payload = {
        "id": book_identifier,
        "title": title,
        "authors": authors,
        "year": int(year_match.group(1)) if year_match else None,
        "language": first_meta(book, "DC", "language", "und"),
        "source": {"file": source_label, "type": "epub"},
        "cover": cover,
        "chapters": chapters,
        "convertedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "converter": f"ebooklib-{package_version('ebooklib')} / markdownify-{package_version('markdownify')}",
    }
    write_book(out_dir, payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert an EPUB into Markdown chapters.")
    parser.add_argument("source", help="path to the .epub file")
    parser.add_argument("--out", required=True, help="output directory, e.g. library/my-book")
    parser.add_argument("--id", required=True, help="book identifier used by the server")
    parser.add_argument("--source-file", default="", help="label stored in book.json source.file")
    parser.add_argument("--force", action="store_true", help="accepted for CLI symmetry")
    parser.add_argument("--no-images", action="store_true", help="skip image extraction")
    parser.add_argument("--no-cover", action="store_true", help="skip cover extraction")
    args = parser.parse_args()

    source_label = args.source_file or os.path.basename(args.source)
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
