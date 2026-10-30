#!/bin/sh
# Stands in for LibreDWG's dwg2dxf in tests: "-y -o <out.dxf> <in.dwg>" copies the DXF named by FAKE_DWG2DXF_SOURCE.
# An empty FAKE_DWG2DXF_SOURCE fails like an unreadable DWG.
out="$3"
if [ -z "$FAKE_DWG2DXF_SOURCE" ]; then echo "ERROR 0x800: Failed to decode file" >&2; exit 1; fi
cp "$FAKE_DWG2DXF_SOURCE" "$out"
