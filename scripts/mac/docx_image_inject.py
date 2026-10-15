#!/usr/bin/env python3
"""Inject Workbench image markers into a saved DOCX without using PyStata images."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}

for prefix in ("w", "r", "wp", "a", "pic"):
    ET.register_namespace(prefix, NS[prefix])
ET.register_namespace("", NS["pr"])

MARKER_RE = re.compile(
    r"^__CODEX_DOCX_IMAGE_V1__\|path=(.*?)\|width=(.*?)\|height=(.*?)"
    r"\|__END_CODEX_DOCX_IMAGE_V1__$"
)
REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
PIC_URI = "http://schemas.openxmlformats.org/drawingml/2006/picture"
EMU_PER_INCH = 914400


def q(prefix: str, name: str) -> str:
    return f"{{{NS[prefix]}}}{name}"


def parse_length(value: str) -> float | None:
    value = value.strip().lower()
    if not value:
        return None
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(in|cm|mm|pt|px)?", value)
    if not match:
        raise ValueError(f"unsupported image dimension: {value}")
    number = float(match.group(1))
    unit = match.group(2) or "in"
    if number <= 0:
        raise ValueError(f"image dimension must be positive: {value}")
    return {
        "in": number,
        "cm": number / 2.54,
        "mm": number / 25.4,
        "pt": number / 72.0,
        "px": number / 96.0,
    }[unit]


def image_size(path: Path) -> tuple[int, int, str, str]:
    data = path.read_bytes()
    suffix = path.suffix.lower()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return width, height, "png", "image/png"
    if data.startswith(b"\xff\xd8"):
        pos = 2
        while pos + 4 <= len(data):
            if data[pos] != 0xFF:
                pos += 1
                continue
            marker = data[pos + 1]
            pos += 2
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if pos + 2 > len(data):
                break
            length = struct.unpack(">H", data[pos : pos + 2])[0]
            if length < 2 or pos + length > len(data):
                break
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                height, width = struct.unpack(">HH", data[pos + 3 : pos + 7])
                return width, height, "jpg", "image/jpeg"
            pos += length
    raise ValueError(f"unsupported or invalid DOCX image: {path} ({suffix or 'no extension'})")


def image_extent(path: Path, width_text: str, height_text: str) -> tuple[int, int, str, str]:
    pixel_width, pixel_height, extension, content_type = image_size(path)
    width_in = parse_length(width_text)
    height_in = parse_length(height_text)
    if width_in is None and height_in is None:
        width_in = pixel_width / 96.0
        height_in = pixel_height / 96.0
    elif width_in is None:
        width_in = height_in * pixel_width / pixel_height
    elif height_in is None:
        height_in = width_in * pixel_height / pixel_width
    return (
        max(1, round(width_in * EMU_PER_INCH)),
        max(1, round(height_in * EMU_PER_INCH)),
        extension,
        content_type,
    )


def drawing_run(rel_id: str, name: str, doc_pr_id: int, cx: int, cy: int) -> ET.Element:
    run = ET.Element(q("w", "r"))
    drawing = ET.SubElement(run, q("w", "drawing"))
    inline = ET.SubElement(
        drawing,
        q("wp", "inline"),
        {"distT": "0", "distB": "0", "distL": "0", "distR": "0"},
    )
    ET.SubElement(inline, q("wp", "extent"), {"cx": str(cx), "cy": str(cy)})
    ET.SubElement(inline, q("wp", "effectExtent"), {"l": "0", "t": "0", "r": "0", "b": "0"})
    ET.SubElement(inline, q("wp", "docPr"), {"id": str(doc_pr_id), "name": name})
    frame = ET.SubElement(inline, q("wp", "cNvGraphicFramePr"))
    ET.SubElement(frame, q("a", "graphicFrameLocks"), {"noChangeAspect": "1"})
    graphic = ET.SubElement(inline, q("a", "graphic"))
    graphic_data = ET.SubElement(graphic, q("a", "graphicData"), {"uri": PIC_URI})
    picture = ET.SubElement(graphic_data, q("pic", "pic"))
    nv = ET.SubElement(picture, q("pic", "nvPicPr"))
    ET.SubElement(nv, q("pic", "cNvPr"), {"id": "0", "name": name})
    ET.SubElement(nv, q("pic", "cNvPicPr"))
    fill = ET.SubElement(picture, q("pic", "blipFill"))
    ET.SubElement(fill, q("a", "blip"), {q("r", "embed"): rel_id})
    stretch = ET.SubElement(fill, q("a", "stretch"))
    ET.SubElement(stretch, q("a", "fillRect"))
    shape = ET.SubElement(picture, q("pic", "spPr"))
    transform = ET.SubElement(shape, q("a", "xfrm"))
    ET.SubElement(transform, q("a", "off"), {"x": "0", "y": "0"})
    ET.SubElement(transform, q("a", "ext"), {"cx": str(cx), "cy": str(cy)})
    geometry = ET.SubElement(shape, q("a", "prstGeom"), {"prst": "rect"})
    ET.SubElement(geometry, q("a", "avLst"))
    return run


def next_numeric_id(values: list[str], prefix: str = "") -> int:
    numbers = []
    for value in values:
        text = value[len(prefix) :] if prefix and value.startswith(prefix) else value
        if text.isdigit():
            numbers.append(int(text))
    return max(numbers, default=0) + 1


def ensure_content_type(root: ET.Element, extension: str, content_type: str) -> None:
    for child in root.findall(q("ct", "Default")):
        if child.get("Extension", "").lower() == extension.lower():
            return
    ET.SubElement(root, q("ct", "Default"), {"Extension": extension, "ContentType": content_type})


def inject(docx_path: Path) -> dict[str, object]:
    if not docx_path.exists() or not zipfile.is_zipfile(docx_path):
        raise ValueError(f"DOCX_IMAGE_COMPAT_INVALID_DOCX: {docx_path}")

    with zipfile.ZipFile(docx_path, "r") as source:
        names = source.namelist()
        required = {"word/document.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"}
        missing = sorted(required.difference(names))
        if missing:
            raise ValueError(f"DOCX_IMAGE_COMPAT_MISSING_PARTS: {','.join(missing)}")
        document = ET.fromstring(source.read("word/document.xml"))
        relationships = ET.fromstring(source.read("word/_rels/document.xml.rels"))
        content_types = ET.fromstring(source.read("[Content_Types].xml"))
        parent_map = {child: parent for parent in document.iter() for child in parent}
        markers: list[tuple[ET.Element, re.Match[str]]] = []
        for text_node in document.iter(q("w", "t")):
            marker = MARKER_RE.fullmatch(text_node.text or "")
            if marker:
                markers.append((text_node, marker))

        unresolved = [
            node.text
            for node in document.iter(q("w", "t"))
            if node.text and "__CODEX_DOCX_IMAGE_V1__" in node.text and not MARKER_RE.fullmatch(node.text)
        ]
        if unresolved:
            raise ValueError("DOCX_IMAGE_COMPAT_MALFORMED_MARKER")
        if not markers:
            return {"ok": True, "docx": str(docx_path), "injected": 0, "unchanged": True}

        rel_ids = [node.get("Id", "") for node in relationships]
        next_rel = next_numeric_id(rel_ids, "rId")
        doc_pr_ids = [node.get("id", "") for node in document.iter(q("wp", "docPr"))]
        next_doc_pr = next_numeric_id(doc_pr_ids)
        media_names = {name.rsplit("/", 1)[-1] for name in names if name.startswith("word/media/")}
        additions: dict[str, bytes] = {}

        generated_images: list[Path] = []
        for index, (text_node, marker) in enumerate(markers, start=1):
            image_path = Path(marker.group(1)).expanduser()
            if not image_path.is_absolute():
                image_path = (docx_path.parent / image_path).resolve()
            if not image_path.exists():
                raise ValueError(f"DOCX_IMAGE_COMPAT_IMAGE_MISSING: {image_path}")
            cx, cy, extension, content_type = image_extent(image_path, marker.group(2), marker.group(3))
            media_index = index
            media_name = f"imageCodex{media_index}.{extension}"
            while media_name in media_names:
                media_index += 1
                media_name = f"imageCodex{media_index}.{extension}"
            media_names.add(media_name)
            additions[f"word/media/{media_name}"] = image_path.read_bytes()
            if image_path.name.endswith(".__docxcompat__.png"):
                generated_images.append(image_path)
            rel_id = f"rId{next_rel}"
            next_rel += 1
            ET.SubElement(
                relationships,
                q("pr", "Relationship"),
                {"Id": rel_id, "Type": REL_IMAGE, "Target": f"media/{media_name}"},
            )
            ensure_content_type(content_types, extension, content_type)

            run = parent_map.get(text_node)
            while run is not None and run.tag != q("w", "r"):
                run = parent_map.get(run)
            if run is None:
                raise ValueError("DOCX_IMAGE_COMPAT_MARKER_WITHOUT_RUN")
            parent = parent_map.get(run)
            if parent is None:
                raise ValueError("DOCX_IMAGE_COMPAT_RUN_WITHOUT_PARENT")
            position = list(parent).index(run)
            parent.remove(run)
            parent.insert(position, drawing_run(rel_id, media_name, next_doc_pr, cx, cy))
            next_doc_pr += 1

        # LibreOffice can reject a package when Content_Types uses an ns0 prefix.
        # ElementTree's default namespace is process-global; restore the package
        # relationships namespace even on failure, including for later injections.
        ET.register_namespace("", NS["ct"])
        try:
            content_types_xml = ET.tostring(content_types, encoding="utf-8", xml_declaration=True)
        finally:
            ET.register_namespace("", NS["pr"])

        rewritten = {
            "word/document.xml": ET.tostring(document, encoding="utf-8", xml_declaration=True),
            "word/_rels/document.xml.rels": ET.tostring(
                relationships, encoding="utf-8", xml_declaration=True
            ),
            "[Content_Types].xml": content_types_xml,
        }
        temp_fd, temp_name = tempfile.mkstemp(prefix=f".{docx_path.name}.", suffix=".tmp", dir=docx_path.parent)
        os.close(temp_fd)
        try:
            with zipfile.ZipFile(temp_name, "w") as target:
                for info in source.infolist():
                    if info.filename in rewritten:
                        target.writestr(info, rewritten[info.filename])
                    else:
                        target.writestr(info, source.read(info.filename))
                for name, data in additions.items():
                    target.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
            with zipfile.ZipFile(temp_name, "r") as verify:
                bad = verify.testzip()
                if bad:
                    raise ValueError(f"DOCX_IMAGE_COMPAT_ZIP_VERIFY_FAILED: {bad}")
                xml = verify.read("word/document.xml")
                if b"__CODEX_DOCX_IMAGE_V1__" in xml:
                    raise ValueError("DOCX_IMAGE_COMPAT_MARKER_REMAINED")
            shutil.copymode(docx_path, temp_name)
            os.replace(temp_name, docx_path)
            for generated_image in generated_images:
                try:
                    generated_image.unlink()
                except FileNotFoundError:
                    pass
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    return {
        "ok": True,
        "docx": str(docx_path),
        "injected": len(markers),
        "unchanged": False,
        "media": sorted(additions),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--docx", required=True)
    args = parser.parse_args()
    docx_path = Path(args.docx).expanduser()
    marker_path = Path(str(docx_path) + ".__docxcompat_ok")
    try:
        result = inject(docx_path)
        marker_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        # codex patch rc.7.10.20: Stata/PyStata may not drain repeated shell
        # output. The atomic marker is the authoritative success receipt.
        return 0
    except Exception as error:  # fail closed so Stata never reports a false document success
        if marker_path.exists():
            marker_path.unlink()
        print(f"DOCX_IMAGE_COMPAT_FAILED: {error}", file=sys.stderr)
        return 69


if __name__ == "__main__":
    raise SystemExit(main())
