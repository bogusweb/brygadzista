"""Writes the small DXF drawings the tests use (#155). Run: python3 cad/make_fixtures.py test/fixtures"""
import sys
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment


def room_label(doc):
    block = doc.blocks.new("POMIESZCZENIE")
    block.add_attdef("NAZWA", (0, 0), dxfattribs={"height": 250})
    block.add_attdef("POW", (0, -400), dxfattribs={"height": 200})
    return block


def sheet(msp, x0, title):
    """One A-size sheet drawn in modelspace: a frame, two rooms with labels and a title block."""
    msp.add_lwpolyline([(x0, 0), (x0 + 42000, 0), (x0 + 42000, 29700), (x0, 29700)], close=True)
    for i, (name, area) in enumerate([("Kuchnia", "9,39 m²"), ("Łazienka", "4,33 m²")]):
        left = x0 + 3000 + i * 12000
        msp.add_lwpolyline([(left, 5000), (left + 10000, 5000), (left + 10000, 15000), (left, 15000)], close=True,
                           dxfattribs={"layer": "SCIANY"})
        insert = msp.add_blockref("POMIESZCZENIE", (left + 2000, 10000))
        insert.add_auto_attribs({"NAZWA": name, "POW": area})
    msp.add_text(title, height=500, dxfattribs={"layer": "OPISY"}).set_placement(
        (x0 + 30000, 2000), align=TextEntityAlignment.LEFT)
    msp.add_mtext("Ściany Ytong PP2,5/0,4 gr. 24 cm\\PNadproże 2xL19/N150",
                  dxfattribs={"char_height": 300, "insert": (x0 + 3000, 20000), "layer": "OPISY"})


def modelspace_drawing(path):
    doc = ezdxf.new("R2018", setup=True)
    doc.layers.add("SCIANY")
    doc.layers.add("OPISY")
    room_label(doc)
    msp = doc.modelspace()
    sheet(msp, 0, "Rzut parteru 1:50")
    sheet(msp, 60000, "Przekrój A-A 1:50")
    hidden = doc.layers.add("UKRYTA")
    hidden.off()
    msp.add_text("Tekst na wyłączonej warstwie", height=300, dxfattribs={"layer": "UKRYTA"}).set_placement((5000, 25000))
    doc.saveas(path)


def paperspace_drawing(path):
    doc = ezdxf.new("R2018", setup=True)
    doc.layers.add("SCIANY")
    doc.layers.add("OPISY")
    room_label(doc)
    sheet(doc.modelspace(), 0, "Rzut parteru 1:50")
    psp = doc.paperspace("Layout1")
    psp.page_setup(size=(420, 297), margins=(10, 10, 10, 10), units="mm")
    psp.add_viewport(center=(210, 160), size=(380, 250), view_center_point=(21000, 14850), view_height=31000)
    psp.add_text("Arkusz A-1", height=5).set_placement((20, 15))
    doc.saveas(path)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    modelspace_drawing(out / "rysunek-model.dxf")
    paperspace_drawing(out / "rysunek-arkusz.dxf")
