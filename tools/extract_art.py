#!/usr/bin/env python3
"""Cut the v1.1 Nano Banana art into game assets (dev tool, needs Pillow).

  python3 tools/extract_art.py

Reads art/v1.1/ and writes:
  assets/sprites.png       every character frame, right- and left-facing, plus a lying-down pose;
                           terrain tiles, plants, objects, vehicles, the dog, townsfolk (art/v1.1/props/)
  assets/buildings/<k>.png one facade per building, background removed
  assets/background.jpg    the parallax sky and hills
  src/render/artdata.js    ART_RECTS {name: [x, y, w, h]} into sprites.png
Every character cell is CELL_W x CELL_H with the feet on the bottom row and
the head centred at x = CELL_W / 2, so the renderer anchors all of them alike.
"""
import re
from collections import deque
from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / 'art' / 'v1.1'
OUT = ROOT / 'assets'
CELL_W, CELL_H, BODY_H = 32, 28, 24   # BODY_H = standing height in px (player sprite was 16x24)

# Player frames: art/v1.1/frames/grower_A.jpg, 2 rows (5 + 3 poses). Boxes are
# hand-picked from that image; the tend box stops before the plant.
GROWER = {
    'idle': (100, 0, 300, 380), 'walk0': (330, 0, 540, 380), 'walk1': (560, 0, 790, 380),
    'walk2': (820, 0, 1030, 380), 'walk3': (1060, 0, 1290, 380),
    'jump': (170, 380, 380, 760), 'tend': (450, 470, 660, 768),
}
GROWER_STAND_H = 340   # idle height in that image: sets the scale for every grower frame

# Reference sheets (front | side | back): the side view is the middle third.
# flip = the side view faces left in the sheet.
SHEETS = {
    'benny': True, 'big_tone': False, 'cop': False, 'doc_renner': False, 'goon': False,
    'june': False, 'marla': False, 'rosa': False, 'saboteur': False, 'skeet': False,
    'thief': False, 'vivian': False, 'walt': False,
}
# NPC walk sheets: art/v1.1/frames/<name>_walk.jpg, one row of 5 (idle + 4 walk), facing right.
WALKERS = ('cop', 'walt', 'benny', 'june', 'rosa', 'thief', 'goon', 'saboteur')
STEP = {'rosa': 12, 'cop': 10}
TOL = {'thief': 48}   # floor shadow under the thief
# Props (art/v1.1/props/*.jpg), read in grid order, left to right, top to bottom.
PLATFORM_PLANK = (348, 369, 684, 397)   # the plank in the platform cell of tiles.jpg (a 16x3 strip in game)
TILE_NAMES = ['dirt', 'grass', 'stone', 'bedrock', 'wood', 'platform', 'concrete', 'ladder', 'road', 'town', 'bgwall']
OBJECT_NAMES = ['pot', 'rack', 'tap', 'barrel', 'bed', 'stove', 'stove_on', 'stash', 'safe', 'floodlight', 'camera', 'lamp']
EQUIP_NAMES = ['tripwire', 'filter', 'generator', 'hatch', 'farmstand', 'dog', 'patrol_car', 'unmarked_car']
EQUIP_SIZE = {'dog': (20, 12), 'patrol_car': (44, 20), 'unmarked_car': (44, 20)}   # default 16x16
PLANT_NAMES = ['seedling', 'veg1', 'veg2', 'flowering', 'ripe', 'over', 'dead', 'male']
PLANT_W, PLANT_H, PLANT_GROUND_Y = 16, 32, 652   # ground line of plants.jpg
TOWNSFOLK = ['ped0', 'ped1', 'ped2', 'ped3', 'runner', 'guard', 'gardener', 'ped4']
# Building boxes (x0, y0, x1, y1) in the 1376x768 source: walls to walls, roof to ground line.
BUILDINGS = {
    'shack': (280, 70, 1090, 662), 'walts': (160, 60, 1190, 640), 'hardware': (168, 30, 1198, 688),
    'bar': (240, 140, 1130, 655), 'clinic': (254, 40, 1124, 642), 'pawn': (188, 50, 1178, 685),
    'alley': (170, 0, 1200, 665), 'townhall': (124, 30, 1244, 665), 'motel': (68, 70, 1308, 620),
}


def flood_cut(img, tol=30, step=None, keep_all=False):
    """Clear the backdrop: flood from the border over pixels near the corner colour
    (or, with step, near the neighbouring pixel, for gradient / textured backdrops).
    Then keep only the largest opaque blob, which drops specks and stray scenery."""
    img = img.convert('RGBA')
    w, h = img.size
    px = img.load()
    bg = px[2, 2]
    seen = bytearray(w * h)
    orig = [None] * (w * h)        # original colour of each cleared pixel
    from_ = [-1] * (w * h)         # which cleared neighbour queued this pixel
    q = deque([(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] +
              [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)])
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        r, g, b, _ = px[x, y]
        ref = bg if step is None else orig[from_[y * w + x]] if from_[y * w + x] >= 0 else (r, g, b)
        if abs(r - ref[0]) + abs(g - ref[1]) + abs(b - ref[2]) > (tol if step is None else step):
            continue
        orig[y * w + x] = (r, g, b)
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                from_[ny * w + nx] = y * w + x
                q.append((nx, ny))
    return img if keep_all else largest_blob(img)


def largest_blob(img):
    w, h = img.size
    a = img.getchannel('A').load()
    label = [0] * (w * h)
    best, best_n, n_id = 0, 0, 0
    for sy in range(h):
        for sx in range(w):
            if not a[sx, sy] or label[sy * w + sx]:
                continue
            n_id += 1
            stack, n = [(sx, sy)], 0
            label[sy * w + sx] = n_id
            while stack:
                x, y = stack.pop()
                n += 1
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and a[nx, ny] and not label[ny * w + nx]:
                        label[ny * w + nx] = n_id
                        stack.append((nx, ny))
            if n > best_n:
                best, best_n = n_id, n
    mask = Image.new('L', (w, h))
    mask.putdata([255 if l == best else 0 for l in label])
    out = Image.new('RGBA', (w, h))
    out.paste(img, (0, 0), mask)
    return out


def to_cell(img, scale):
    """Trim, scale, harden the alpha, and drop into a head-centred, feet-down cell."""
    img = img.crop(img.getbbox())
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    a = img.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
    img.putalpha(a)
    img = img.crop(img.getbbox())
    top = img.crop((0, 0, img.width, max(1, img.height // 6)))      # head rows
    bb = top.getbbox() or (0, 0, img.width, 1)
    head_x = (bb[0] + bb[2]) // 2
    cell = Image.new('RGBA', (CELL_W, CELL_H))
    cell.paste(img, (CELL_W // 2 - head_x, CELL_H - img.height), img)   # clips anything outside
    return cell


def facade(img, box, tol=24):
    """Building: crop to its box, then clear the sky above the roofline with a
    scan down each column that stops where the colour leaves that column's sky
    colour (on a median-filtered copy, so dithered sky and stars do not stop
    the scan early). Boxes with no sky (alley) stay a full rectangle."""
    img = img.convert('RGBA').crop(box)
    if box[1] == 0:
        return img
    test = img.convert('RGB').filter(ImageFilter.MedianFilter(7)).load()
    px = img.load()
    for x in range(img.width):
        sky = test[x, 3]
        for y in range(img.height):
            if sum(abs(a - b) for a, b in zip(test[x, y], sky)) > tol:
                break
            px[x, y] = (0, 0, 0, 0)
    return img


def grid_cell(img, cols, rows, c, r, inset=10):
    w, h = img.width / cols, img.height / rows
    return img.crop((round(c * w) + inset, round(r * h) + inset, round((c + 1) * w) - inset, round((r + 1) * h) - inset))


def harden(img):
    img.putalpha(img.getchannel('A').point(lambda v: 255 if v >= 128 else 0))
    return img


def fit(img, w, h):
    """Trim, scale to fit w x h keeping the aspect, and stand it bottom-centre in a w x h cell."""
    img = img.crop(img.getbbox())
    k = min(w / img.width, h / img.height)
    img = harden(img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS))
    cell = Image.new('RGBA', (w, h))
    cell.paste(img, ((w - img.width) // 2, h - img.height), img)
    return cell


def blobs(img, n):
    """The n largest opaque blobs (after a border flood), left to right, each trimmed."""
    from PIL import ImageChops
    w, h = img.size
    a = img.getchannel('A').load()
    label, found, n_id = [0] * (w * h), [], 0
    for sy in range(h):
        for sx in range(w):
            if not a[sx, sy] or label[sy * w + sx]:
                continue
            n_id += 1
            stack, pts = [(sx, sy)], []
            label[sy * w + sx] = n_id
            while stack:
                x, y = stack.pop()
                pts.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and a[nx, ny] and not label[ny * w + nx]:
                        label[ny * w + nx] = n_id
                        stack.append((nx, ny))
            found.append((len(pts), n_id, min(p[0] for p in pts)))
    keep = sorted(sorted(found, reverse=True)[:n], key=lambda f: f[2])
    out = []
    for _, lid, _ in keep:
        mask = Image.new('L', (w, h))
        mask.putdata([255 if l == lid else 0 for l in label])
        part = Image.new('RGBA', (w, h))
        part.paste(img, (0, 0), mask)
        out.append(part.crop(part.getbbox()))
    return out


def hue_shift(img, deg):
    """Bred strains: same plant, purple instead of green (alpha kept)."""
    a = img.getchannel('A')
    hsv = img.convert('RGB').convert('HSV')
    hch, s, v = hsv.split()
    hch = hch.point(lambda x: (x + round(deg * 255 / 360)) % 256)
    out = Image.merge('HSV', (hch, s, v)).convert('RGBA')
    out.putalpha(a)
    return out


def props():
    """Tiles, plants, objects, equipment, vehicles, dog, townsfolk -> {name: image}."""
    out = {}
    P = ART / 'props'
    tiles = Image.open(P / 'tiles.jpg').convert('RGBA')
    for i, name in enumerate(TILE_NAMES):
        cell = grid_cell(tiles, 4, 3, i % 4, i // 4)
        side = min(cell.size)
        cell = cell.crop(((cell.width - side) // 2, (cell.height - side) // 2, (cell.width + side) // 2, (cell.height + side) // 2))
        small = ImageEnhance.Brightness(cell.convert('RGB')).enhance(1.25).resize((16, 16), Image.LANCZOS).convert('RGBA')
        if name == 'ladder':   # sits over the sky: the black backdrop goes clear
            small.putalpha(small.convert('L').point(lambda v: 255 if v > 30 else 0))
        out['tile_' + name] = small
    plank = tiles.crop(PLATFORM_PLANK).convert('RGB').resize((16, 3), Image.LANCZOS).convert('RGBA')
    out['tile_platform'] = Image.new('RGBA', (16, 16))
    out['tile_platform'].paste(plank, (0, 0))

    plants = Image.open(P / 'plants.jpg')
    parts = blobs(flood_cut(plants.crop((0, 0, plants.width, PLANT_GROUND_Y)), keep_all=True), len(PLANT_NAMES))
    k = (PLANT_H - 2) / max(p.height for p in parts)
    for name, part in zip(PLANT_NAMES, parts):
        part = harden(part.resize((max(1, round(part.width * k)), max(1, round(part.height * k))), Image.LANCZOS))
        part = part.crop((max(0, (part.width - PLANT_W) // 2), 0, max(0, (part.width - PLANT_W) // 2) + min(PLANT_W, part.width), part.height))
        cell = Image.new('RGBA', (PLANT_W, PLANT_H))
        cell.paste(part, ((PLANT_W - part.width) // 2, PLANT_H - part.height), part)
        out['plant_' + name] = cell
        out['plant_b_' + name] = hue_shift(cell, 160)

    objs = Image.open(P / 'objects.jpg')
    for i, name in enumerate(OBJECT_NAMES):
        out['obj_' + name] = fit(flood_cut(grid_cell(objs, 4, 3, i % 4, i // 4)), 16, 16 if name != 'pot' else 10)
    pot = Image.new('RGBA', (16, 16))   # pot stands on the ground, soil line ~ y 7
    pot.paste(out['obj_pot'], (0, 6))
    out['obj_pot'] = pot

    equip = Image.open(P / 'equipment.jpg')
    for i, name in enumerate(EQUIP_NAMES):
        w, h = EQUIP_SIZE.get(name, (16, 16))
        img = fit(flood_cut(grid_cell(equip, 4, 2, i % 4, i // 4)), w, h)
        out[name if name in EQUIP_SIZE else 'obj_' + name] = img
    for name in ('dog', 'patrol_car', 'unmarked_car'):
        out[name + 'L'] = out[name].transpose(Image.FLIP_LEFT_RIGHT)
    out['dog_down'] = out['dog'].transpose(Image.FLIP_TOP_BOTTOM).crop(out['dog'].transpose(Image.FLIP_TOP_BOTTOM).getbbox())

    folk = Image.open(P / 'townsfolk.jpg')
    for name, part in zip(TOWNSFOLK, blobs(flood_cut(folk, keep_all=True), len(TOWNSFOLK))):
        cell = to_cell(part, BODY_H / part.height)
        out[name] = cell
        out[name + 'L'] = cell.transpose(Image.FLIP_LEFT_RIGHT)
    return out


def walk_frames(name):
    """The 4 walk poses from a walk sheet, scaled to BODY_H by the tallest figure."""
    img = flood_cut(Image.open(ART / 'frames' / f'{name}_walk.jpg'), tol=12, keep_all=True)   # flat backdrop close to the clothes
    w, h = img.size
    bg = Image.open(ART / 'frames' / f'{name}_walk.jpg').convert('RGB').getpixel((2, 2))
    px = img.load()
    for y in range(h):   # backdrop pockets the flood can't reach (between the legs)
        for x in range(w):
            r, g, b, al = px[x, y]
            if al and abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) <= 12:
                px[x, y] = (0, 0, 0, 0)
    a = img.getchannel('A')
    for y in range(h):   # drop the drawn ground line (one long unbroken run), which would join all 5 figures
        if max(map(len, re.findall(rb'[^\x00]+', a.crop((0, y, w, y + 1)).tobytes())), default=0) > w * 0.4:
            img.paste((0, 0, 0, 0), (0, y, w, y + 1))
    # Strides nearly touch the next figure, so find the 5 heads in a band under the top
    # of the figures and cut at the emptiest column between neighbouring heads.
    a = img.getchannel('A')
    top = next(y for y in range(h) if a.crop((0, y, w, y + 1)).histogram()[255] >= 20)   # skip specks
    band = a.crop((0, top, w, top + h // 10))
    cols = [band.crop((x, 0, x + 1, band.height)).getbbox() is not None for x in range(w)]
    heads, start = [], None
    for x, on in enumerate(cols + [False]):
        if on and start is None:
            start = x
        elif not on and start is not None:
            if x - start >= 15:          # skip specks
                heads.append((start + x) // 2)
            start = None
    assert len(heads) == 5, (name, heads)
    fill = [a.crop((x, 0, x + 1, h)).histogram()[255] for x in range(w)]
    span = (heads[-1] - heads[0]) // 4
    cuts = [max(0, heads[0] - span)]
    cuts += [min(range(l + span // 4, r - span // 4), key=fill.__getitem__) for l, r in zip(heads, heads[1:])]
    cuts += [min(w, heads[-1] + span)]
    figs = [img.crop((x0, 0, x1, h)) for x0, x1 in zip(cuts, cuts[1:])]
    figs = [f.crop(largest_blob(f).getbbox()) for f in figs]   # trim to the body, not stray specks
    scale = BODY_H / max(f.height for f in figs[1:])   # the idle pose can be off-angle or carry junk
    return [to_cell(f, scale) for f in figs[1:]]


def main():
    cells = {}
    sheet = Image.open(ART / 'frames' / 'grower_A.jpg')
    for name, box in GROWER.items():
        cells['grower_' + name] = to_cell(flood_cut(sheet.crop(box)), BODY_H / GROWER_STAND_H)
    for name, flip in SHEETS.items():
        ref = Image.open(ART / f'{name}_ref_sheet.jpg')
        side = flood_cut(ref.crop((ref.width // 3, 0, 2 * ref.width // 3, ref.height)), tol=TOL.get(name, 30), step=STEP.get(name))
        side = side.crop(side.getbbox())
        if flip:
            side = side.transpose(Image.FLIP_LEFT_RIGHT)
        cells[name] = to_cell(side, BODY_H / side.height)
    for name in WALKERS:
        for i, c in enumerate(walk_frames(name)):
            cells[f'{name}_walk{i}'] = c

    frames = {}
    for name, c in cells.items():
        frames[name] = c
        frames[name + 'L'] = c.transpose(Image.FLIP_LEFT_RIGHT)
    for name in SHEETS:   # knocked out / downed: lying on the ground, head left
        frames[name + '_down'] = cells[name].crop(cells[name].getbbox()).rotate(90, expand=True)

    frames.update(props())
    size, rects, x, y, row_h = 512, {}, 0, 0, 0
    atlas = Image.new('RGBA', (size, 2 * size))
    for name, f in frames.items():
        if x + f.width > size:
            x, y, row_h = 0, y + row_h, 0
        atlas.paste(f, (x, y))
        rects[name] = [x, y, f.width, f.height]
        x += f.width
        row_h = max(row_h, f.height)
    assert y + row_h <= 2 * size, 'sprite atlas overflow'
    OUT.mkdir(exist_ok=True)
    atlas.crop((0, 0, size, y + row_h)).save(OUT / 'sprites.png')

    Image.open(ART / 'props' / 'background.jpg').save(OUT / 'background.jpg', quality=90)   # sky + hills backdrop
    (OUT / 'buildings').mkdir(exist_ok=True)
    for key, box in BUILDINGS.items():
        facade(Image.open(ART / 'buildings' / f'{key}.jpg'), box).save(OUT / 'buildings' / f'{key}.png')

    lines = [f"  {n}: [{', '.join(map(str, r))}]," for n, r in rects.items()]
    (ROOT / 'src' / 'render' / 'artdata.js').write_text(
        '// artdata.js — GENERATED by tools/extract_art.py, do not edit.\n'
        '// Rects into assets/sprites.png. Character cells are '
        f'{CELL_W}x{CELL_H}: feet on the bottom row, head centred.\n'
        f'export const ART_CELL_W = {CELL_W};\n'
        'export const ART_RECTS = {\n' + '\n'.join(lines) + '\n};\n')
    print(f'{len(frames)} frames, atlas {size}x{y + row_h}, {len(BUILDINGS)} facades')


if __name__ == '__main__':
    main()
