#!/usr/bin/env python3

from __future__ import annotations

import argparse
import binascii
import os
import struct
import zlib
from pathlib import Path


PALETTE = {
    ".": (0, 0, 0, 0),
    "N": (36, 20, 66, 255),
    "B": (62, 39, 104, 255),
    "P": (109, 78, 163, 255),
    "L": (167, 128, 226, 255),
    "F": (247, 244, 255, 255),
    "Y": (255, 196, 92, 255),
    "O": (255, 143, 68, 255),
    "R": (236, 84, 96, 255),
    "D": (19, 26, 37, 255),
    "W": (255, 255, 255, 255),
}


SPRITE = [
    "................................",
    "................................",
    "...........NNNNNNNNNN...........",
    ".........NNBBBBBBBBBBNN.........",
    "........NBBPPPPPPPPPPBBN........",
    ".......NBPPPPPPPPPPPPPPBN.......",
    "......NBPPPPPPPPPPPPPPPPBN......",
    ".....NBPPPPPPPPPPPPPPPPPPBN.....",
    ".....NBPPPPPPPPPPPPPPPPPPBN.....",
    "....NBPPPPPPPPPPPPPPPPPPPPBN....",
    "....NBPPPPPPPPPPPPPPPPPPPPBN....",
    "....NBPPPPPPPPPPPPPPPPPPPPBN....",
    "....NBPPPPPPPPPPPPPPPPPPPPBN....",
    "....NBPPPPPPPYYYYYYPPPPPPPBN....",
    "....NBPPPPPYYYYYYYYYYPPPPPBN....",
    "....NBPPPPPYYFYYYYFYYPPPPPBN....",
    "....NBPPPPPYYYYYYYYYYPPPPPBN....",
    "....NBPPPPPYYYYYYYYYYPPPPPBN....",
    "....NBPPPPPPYYOOOOYYPPPPPPBN....",
    "....NBPPPPPPPYOYYOYYPPPPPPBN....",
    "....NBPPPPPPPYYYYYYYPPPPPPBN....",
    "....NBPPPPPPPPORRROPPPPPPPBN....",
    "....NBPPPPPPPPPOROPPPPPPPPBN....",
    "....NBPPPPPPPPPPPPPPPPPPPPBN....",
    "....NBPPPPPPPPDDDDPPPPPPPPBN....",
    ".....NBPPPPPPDFFFFDPPPPPPBN.....",
    ".....NBPPPPPPDFFFFDPPPPPPBN.....",
    "......NBPPPPPDDDDDDPPPPBN......",
    ".......NBPPPPPPPPPPPPPPBN.......",
    "........NBBPPPPPPPPPPBBN........",
    ".........NNBBBBBBBBBBNN.........",
    "...........NNNNNNNNNN...........",
]


def write_png(path: Path, width: int, height: int, rgba_rows: list[bytes]) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + row for row in rgba_rows)
    png = [
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(raw, 9)),
        chunk(b"IEND", b""),
    ]
    path.write_bytes(b"".join(png))


def upscale(rows: list[str], scale: int) -> list[bytes]:
    out: list[bytes] = []
    for row in rows:
        pixels = b"".join(bytes(PALETTE[cell]) for cell in row)
        expanded = b"".join(pixel * scale for pixel in [pixels[i : i + 4] for i in range(0, len(pixels), 4)])
        for _ in range(scale):
            out.append(expanded)
    return out


def scale_sprite(rows: list[str], size: int) -> list[bytes]:
    base = len(rows)
    scale = max(1, size // base)
    scaled = upscale(rows, scale)
    content_size = base * scale
    left_pad = max(0, (size - content_size) // 2)
    right_pad = max(0, size - content_size - left_pad)
    transparent = bytes((0, 0, 0, 0))
    padded_rows = []
    for row in scaled[:size]:
        padded = (transparent * left_pad) + row[: content_size * 4] + (transparent * right_pad)
        padded_rows.append(padded[: size * 4])
    top_pad = max(0, (size - len(padded_rows)) // 2)
    bottom_pad = max(0, size - len(padded_rows) - top_pad)
    blank = transparent * size
    return [blank] * top_pad + padded_rows + [blank] * bottom_pad


def write_ico(path: Path, png_assets: list[tuple[int, bytes]]) -> None:
    header = struct.pack("<HHH", 0, 1, len(png_assets))
    offset = 6 + (16 * len(png_assets))
    entries = []
    payload = []
    for size, png_blob in png_assets:
        width = 0 if size >= 256 else size
        height = 0 if size >= 256 else size
        entries.append(
            struct.pack(
                "<BBBBHHII",
                width,
                height,
                0,
                0,
                1,
                32,
                len(png_blob),
                offset,
            )
        )
        payload.append(png_blob)
        offset += len(png_blob)
    path.write_bytes(header + b"".join(entries) + b"".join(payload))


def generate_assets(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 44, 48, 50, 64, 128, 150, 256, 310]
    png_blobs: list[tuple[int, bytes]] = []

    for size in sizes:
        rows = scale_sprite(SPRITE, size)
        file_path = output_dir / f"pixel-ccf-{size}.png"
        write_png(file_path, size, size, rows)
        png_blobs.append((size, file_path.read_bytes()))

    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_blobs = [(size, blob) for size, blob in png_blobs if size in ico_sizes]
    write_ico(output_dir / "ChaosCatFamiliar.ico", ico_blobs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a fallback pixel-art icon set for Windows packaging.")
    parser.add_argument(
        "--output-dir",
        default=str(Path("packaging") / "windows" / "assets" / "pixel-art"),
        help="Directory to write generated PNG and ICO assets.",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    generate_assets(output_dir)
    print(f"[ccf-pixel-icon] wrote assets to {output_dir}")


if __name__ == "__main__":
    main()
