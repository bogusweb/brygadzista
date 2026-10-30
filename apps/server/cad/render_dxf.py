"""Renders a DXF drawing to a multi-page PDF for the project index (#155).

Usage: render_dxf.py <input.dxf> <output.pdf>

One page per paperspace layout that has content; a drawing without any is split into the separate sheets of its
modelspace (groups of entities with empty space between them). ezdxf draws text as outlines, so every text is
also written under the drawing in white real text: invisible on the page, but pdftotext reads it, and the index
gets the room names, notes and title blocks with their positions. Prints a JSON summary to stdout.
"""
import json
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import ezdxf
from ezdxf import bbox, disassemble, recover
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
from ezdxf.math import BoundingBox2d, Matrix44, Vec3

TEXT_TYPES = {"TEXT", "MTEXT", "ATTRIB"}
# Modelspace sheets are placed on a page of this size (mm), turned to match their shape.
SHEET_MM = (841.0, 594.0)
MARGIN_MM = 10.0
# Entities closer than this share of the drawing's size count as one sheet; groups smaller than MIN_SHEET_SHARE of
# the largest one (a stray note, a north arrow) join the nearest sheet instead of becoming a page of their own.
GAP_SHARE = 0.01
MIN_SHEET_SHARE = 0.02
RENDER_CONFIG = config.Configuration(
    background_policy=config.BackgroundPolicy.WHITE,
    color_policy=config.ColorPolicy.COLOR,
)


def plain_text(entity):
    if entity.dxftype() == "MTEXT":
        return entity.plain_text(split=False).strip()
    return entity.plain_text().strip()


def text_rotation(entity):
    if entity.dxftype() == "MTEXT":
        return entity.get_rotation()
    return entity.dxf.get("rotation", 0.0)


def visible_layers(doc):
    return {layer.dxf.name.lower() for layer in doc.layers if layer.is_on() and not layer.is_frozen()}


def collect_texts(entities, layers):
    """Texts of the given entities, block contents and dimension labels included, in their own coordinates."""
    texts = []
    for entity in disassemble.recursive_decompose(entities):
        if entity.dxftype() not in TEXT_TYPES or entity.dxf.get("layer", "0").lower() not in layers:
            continue
        if entity.dxftype() == "ATTRIB" and entity.is_invisible:
            continue
        content = plain_text(entity)
        if not content:
            continue
        texts.append({
            "text": content,
            "layer": entity.dxf.get("layer", "0"),
            "insert": Vec3(entity.dxf.insert),
            "height": float(entity.dxf.get("char_height" if entity.dxftype() == "MTEXT" else "height", 2.5)),
            "rotation": float(text_rotation(entity)),
        })
    return texts


def viewport_texts(viewport, model_texts):
    """Modelspace texts seen through a paperspace viewport, moved to paperspace coordinates."""
    m = viewport.get_transformation_matrix()
    scale = viewport.get_scale()
    center = Vec3(viewport.dxf.center)
    half_w, half_h = viewport.dxf.width / 2, viewport.dxf.height / 2
    frozen = {name.lower() for name in viewport.frozen_layers}
    seen = []
    for text in model_texts:
        if text["layer"].lower() in frozen:
            continue
        p = m.transform(text["insert"])
        if abs(p.x - center.x) <= half_w and abs(p.y - center.y) <= half_h:
            seen.append({**text, "insert": p, "height": text["height"] * scale,
                         "rotation": text["rotation"] + viewport.dxf.get("view_twist_angle", 0.0)})
    return seen


def add_hidden_text(root, texts, m: Matrix44):
    """White text under the drawing at the places where ezdxf drew the outlines."""
    group = ET.Element("g", {"fill": "#ffffff", "font-family": "DejaVu Sans"})
    up = m.transform_direction(Vec3(0, 1, 0))
    scale = up.magnitude
    for text in texts:
        p = m.transform(text["insert"])
        size = max(text["height"] * scale, 0.1)
        # The page's y axis points down, so a DXF angle turns the other way.
        angle = -text["rotation"]
        line_step = Vec3(0, -text["height"] * 1.6).rotate_deg(text["rotation"])
        for i, line in enumerate(text["text"].splitlines()):
            q = m.transform(text["insert"] + line_step * i) if i else p
            element = ET.SubElement(group, "text", {
                "x": f"{q.x:.1f}", "y": f"{q.y:.1f}", "font-size": f"{size:.1f}",
            })
            if angle:
                element.set("transform", f"rotate({angle:.1f} {q.x:.1f} {q.y:.1f})")
            element.text = line
    entities = next(child for child in root if child.tag == "g")
    root.insert(list(root).index(entities), group)


def sheet_page(box: BoundingBox2d):
    width, height = SHEET_MM if box.size.x >= box.size.y else SHEET_MM[::-1]
    return layout.Page(width, height, layout.Units.mm, layout.Margins.all(MARGIN_MM))


def render_svg(doc, dxf_layout, page, texts, render_box=None, handles=None):
    ctx = RenderContext(doc)
    backend = svg.SVGBackend()
    frontend = Frontend(ctx, backend, config=RENDER_CONFIG)
    filter_func = (lambda entity: entity.dxf.handle in handles) if handles is not None else None
    frontend.draw_layout(dxf_layout, finalize=True, filter_func=filter_func)
    settings = layout.Settings(fit_page=True)
    root = backend.get_xml_root_element(page, settings=settings, render_box=render_box)
    if backend.transformation_matrix is None:
        return None
    add_hidden_text(root, texts, backend.transformation_matrix)
    return ET.tostring(root, encoding="unicode", xml_declaration=True)


def paperspace_has_content(psp):
    return any(not (e.dxftype() == "VIEWPORT" and e.dxf.get("id", 0) == 1) for e in psp)


def find_sheets(msp):
    """Groups modelspace entities into sheets: boxes that touch (with a small gap allowed) belong together."""
    boxes = []
    for entity in msp:
        try:
            extents = bbox.extents([entity], fast=True)
        except Exception:
            continue
        if extents.has_data:
            boxes.append((entity.dxf.handle, extents))
    if not boxes:
        return []
    total = bbox.BoundingBox()
    for _, extents in boxes:
        total.extend([extents.extmin, extents.extmax])
    gap = max(total.size.x, total.size.y) * GAP_SHARE

    parent = list(range(len(boxes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    # Sweep along x: only boxes whose x ranges overlap (with the gap) can touch.
    order = sorted(range(len(boxes)), key=lambda i: boxes[i][1].extmin.x)
    active = []
    for i in order:
        box = boxes[i][1]
        active = [j for j in active if boxes[j][1].extmax.x + gap >= box.extmin.x]
        for j in active:
            other = boxes[j][1]
            if other.extmin.y - gap <= box.extmax.y and box.extmin.y - gap <= other.extmax.y:
                parent[find(i)] = find(j)
        active.append(i)

    groups = {}
    for i, (handle, extents) in enumerate(boxes):
        group = groups.setdefault(find(i), {"handles": set(), "box": bbox.BoundingBox()})
        group["handles"].add(handle)
        group["box"].extend([extents.extmin, extents.extmax])
    sheets = sorted(groups.values(), key=lambda g: g["box"].size.x * g["box"].size.y, reverse=True)
    largest = sheets[0]["box"].size.x * sheets[0]["box"].size.y
    kept = [s for s in sheets if s["box"].size.x * s["box"].size.y >= largest * MIN_SHEET_SHARE] or sheets[:1]
    # Sorted by size, so the kept sheets come first.
    for small in sheets[len(kept):]:
        nearest = min(kept, key=lambda s: (s["box"].center - small["box"].center).magnitude)
        nearest["handles"] |= small["handles"]
        nearest["box"].extend([small["box"].extmin, small["box"].extmax])
    # Reading order: rows from the top, left to right within a row.
    row = max(total.size.y, 1.0) / 20
    kept.sort(key=lambda s: (-round(s["box"].extmax.y / row), s["box"].extmin.x))
    return kept


def in_box(text, box):
    p = text["insert"]
    return box.extmin.x <= p.x <= box.extmax.x and box.extmin.y <= p.y <= box.extmax.y


def render(path_in, path_out):
    doc, auditor = recover.readfile(path_in)
    layers = visible_layers(doc)
    msp = doc.modelspace()
    model_texts = collect_texts(msp, layers)
    pages = []

    for name in doc.layout_names_in_taborder():
        if name == "Model":
            continue
        psp = doc.paperspace(name)
        if not paperspace_has_content(psp):
            continue
        texts = collect_texts([e for e in psp if e.dxftype() != "VIEWPORT"], layers)
        for viewport in psp.query("VIEWPORT"):
            if viewport.dxf.get("id", 0) != 1 and viewport.is_visible:
                texts += viewport_texts(viewport, model_texts)
        page = layout.Page.from_dxf_layout(psp)
        if page.width == 0 or page.height == 0:
            page = layout.Page(*SHEET_MM, layout.Units.mm, layout.Margins.all(MARGIN_MM))
        content = render_svg(doc, psp, page, texts)
        if content:
            pages.append({"name": name, "svg": content, "texts": len(texts)})

    if not pages:
        for i, sheet in enumerate(find_sheets(msp), start=1):
            box = BoundingBox2d([sheet["box"].extmin, sheet["box"].extmax])
            texts = [t for t in model_texts if in_box(t, sheet["box"])]
            content = render_svg(doc, msp, sheet_page(box), texts, render_box=box, handles=sheet["handles"])
            if content:
                pages.append({"name": f"Model {i}", "svg": content, "texts": len(texts)})

    if not pages:
        raise SystemExit("Rysunek nie ma nic do narysowania")

    with tempfile.TemporaryDirectory() as tmp:
        files = []
        for i, page in enumerate(pages, start=1):
            file = Path(tmp) / f"page-{i:04d}.svg"
            file.write_text(page["svg"], encoding="utf-8")
            files.append(str(file))
        subprocess.run(["rsvg-convert", "-f", "pdf", "-o", path_out, *files], check=True)

    print(json.dumps({
        "dxfVersion": doc.dxfversion,
        "repairs": len(auditor.fixes),
        "pages": [{"name": p["name"], "texts": p["texts"]} for p in pages],
    }, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    ezdxf.options.load_proxy_graphics = True
    render(sys.argv[1], sys.argv[2])
