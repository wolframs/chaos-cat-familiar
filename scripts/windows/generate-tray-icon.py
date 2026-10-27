"""Build the tray's pixel cat as real PNG/ICO assets; no image libraries required."""
from pathlib import Path
import runpy

PALETTE = {
    '.': (0, 0, 0, 0),
    'L': (190, 154, 255, 255),
    'P': (116, 61, 186, 255),
    'D': (75, 39, 123, 255),
    'E': (237, 175, 252, 255),
    'Y': (255, 236, 165, 255),
    'N': (33, 17, 55, 255),
}
SPRITE = [
    '................',
    '..LL........LL..',
    '..LPL......LPL..',
    '..LPPL....LPPL..',
    '..LPPPLLLLPPPL..',
    '.LPPPPPPPPPPPPL.',
    '.LPPPPPPPPPPPPL.',
    '.LPPYYPPPPYYPPL.',
    '.LPPYNPPPPNYPPL.',
    '.DPPPPPEEPPPPPD.',
    '..DPPPDPPDPPPD..',
    '..DPPPPDDPPPPD..',
    '...DPPPPPPPPD...',
    '....DDPPPPDD....',
    '......DDDD......',
    '................',
]


def generate(output):
    assert len(SPRITE) == 16 and all(len(row) == 16 for row in SPRITE)
    helpers = runpy.run_path(str(Path(__file__).with_name('generate-pixel-icon.py')))
    output.mkdir(parents=True, exist_ok=True)
    assets = []
    # Windows tray sizes at 100%, 125%, 150% and 200%, plus larger displays.
    for size in (16, 20, 24, 32, 40, 48, 64):
        rows = [b''.join(bytes(PALETTE[SPRITE[y * 16 // size][x * 16 // size]]) for x in range(size)) for y in range(size)]
        target = output / f'chaos-cat-{size}.png'
        helpers['write_png'](target, size, size, rows)
        assets.append((size, target.read_bytes()))
        if size not in (16, 32, 64):
            target.unlink()  # Intermediate ICO resolutions are regenerable.
    helpers['write_ico'](output / 'chaos-cat.ico', assets)


if __name__ == '__main__':
    generate(Path(__file__).resolve().parents[2] / 'apps/windows-shell/assets/tray')
