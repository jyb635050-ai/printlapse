#!/usr/bin/env python
"""
make_fixtures.py — 用本机 Bambu Studio 命令行切出真实的 A1 测试样本，放进 fixtures/。

    python tools/make_fixtures.py

产出：
    fixtures/cube.gcode.3mf       20mm 方块，单色，100 层
    fixtures/bearing4c.gcode.3mf  6210 轴承四色件（红/蓝/白/黑），100 层，有擦料塔
    fixtures/tower.gcode.3mf      自造 150mm 高扭转齿形塔，约 750 层，压性能用

为什么要"展平"配置：直接把 resources/profiles/BBL 下的 A1 json 喂给命令行，
inherits 不会展开，切出来热床变 200x200、没有 A1 开机代码。所以这里自己把
inherits 链和 include 模板合并成一份完整的 json 再喂。
扁平后的工艺 json 必须保留 compatible_printers 并删掉 compatible_printers_condition，
否则 result.json 里 return_code = -17（"printer is not compatible"）。
"""
import json, math, os, struct, subprocess, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "fixtures")
EXE = r"D:\3D PRINT\Bambu Studio\bambu-studio.exe"
PROFILES = r"D:\3D PRINT\Bambu Studio\resources\profiles\BBL"
BEARING = r"D:\blender\6210_print\6210_colored.3mf"
MACHINE = "Bambu Lab A1 0.4 nozzle"
PROCESS = "0.20mm Standard @BBL A1"
FILAMENT = "Bambu PLA Basic @BBL A1"


def find_profile(kind, name):
    base = os.path.join(PROFILES, kind)
    p = os.path.join(base, name + ".json")
    if os.path.exists(p):
        return p
    for root, _, files in os.walk(base):
        if name + ".json" in files:
            return os.path.join(root, name + ".json")
    raise FileNotFoundError(kind + "/" + name)


def load_flat(kind, name):
    with open(find_profile(kind, name), encoding="utf-8") as f:
        d = json.load(f)
    merged = load_flat(kind, d["inherits"]) if d.get("inherits") else {}
    for inc in d.get("include", []):
        part = load_flat(kind, inc)
        merged.update({k: v for k, v in part.items() if k not in ("name", "type", "from", "instantiation")})
    merged.update(d)
    merged.pop("inherits", None)
    merged.pop("include", None)
    return merged


def write_json(d, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    return path


def slice_model(model, out, work, filament_colours):
    machine = load_flat("machine", MACHINE)
    process = load_flat("process", PROCESS)
    process["compatible_printers"] = [MACHINE]
    process.pop("compatible_printers_condition", None)
    m = write_json(machine, os.path.join(work, "machine.json"))
    p = write_json(process, os.path.join(work, "process.json"))
    fils = []
    for i, c in enumerate(filament_colours):
        fd = load_flat("filament", FILAMENT)
        fd["filament_colour"] = [c]
        fd["name"] = "PLA %d" % (i + 1)
        fils.append(write_json(fd, os.path.join(work, "filament%d.json" % i)))
    result = os.path.join(work, "result.json")
    if os.path.exists(result):
        os.remove(result)
    cmd = [EXE, "--slice", "0", "--arrange", "1", "--export-3mf", out,
           "--load-settings", m + ";" + p, "--load-filaments", ";".join(fils), model]
    subprocess.run(cmd, cwd=work, timeout=900)
    with open(result, encoding="utf-8") as f:
        r = json.load(f)
    if r.get("return_code") != 0:
        raise SystemExit("切片失败 %s: return_code=%s %s" % (os.path.basename(out), r.get("return_code"), r.get("error_string")))


def cube_stl(path, size=20.0):
    v = [(0, 0, 0), (size, 0, 0), (size, size, 0), (0, size, 0),
         (0, 0, size), (size, 0, size), (size, size, size), (0, size, size)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
         (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    write_stl(path, [tuple(v[i] for i in t) for t in f])


def tower_stl(path, height=150.0):
    n, rings_n = 96, 60
    def rad(a, z):
        return 40 + 3 * math.sin(12 * a + z * 0.08)
    rings = []
    for k in range(rings_n + 1):
        z = height * k / rings_n
        rings.append([(rad(2 * math.pi * i / n, z) * math.cos(2 * math.pi * i / n),
                       rad(2 * math.pi * i / n, z) * math.sin(2 * math.pi * i / n), z) for i in range(n)])
    tris = []
    for k in range(rings_n):
        for i in range(n):
            a, b = rings[k][i], rings[k][(i + 1) % n]
            c, d = rings[k + 1][i], rings[k + 1][(i + 1) % n]
            tris += [(a, b, d), (a, d, c)]
    for k, z, flip in ((0, 0.0, True), (rings_n, height, False)):
        cen = (0.0, 0.0, z)
        for i in range(n):
            a, b = rings[k][i], rings[k][(i + 1) % n]
            tris.append((cen, b, a) if flip else (cen, a, b))
    write_stl(path, tris)


def write_stl(path, tris):
    with open(path, "wb") as o:
        o.write(b"\0" * 80)
        o.write(struct.pack("<I", len(tris)))
        for t in tris:
            o.write(struct.pack("<3f", 0, 0, 0))
            for p in t:
                o.write(struct.pack("<3f", *p))
            o.write(b"\0\0")


def report(path):
    with zipfile.ZipFile(path) as z:
        g = z.read("Metadata/plate_1.gcode").decode("utf-8", "replace")
    lines = g.count("\n")
    layers = sum(1 for ln in g.splitlines() if ln.startswith("; CHANGE_LAYER"))
    header = next((ln for ln in g.splitlines()[:10] if "total layer number" in ln), "")
    print("%-22s %8.2f MB  行数 %7d  层数 %4d  (%s)" % (
        os.path.basename(path), len(g) / 1e6, lines, layers, header.strip("; ")))


def main():
    os.makedirs(FIX, exist_ok=True)
    only = sys.argv[1:]
    with tempfile.TemporaryDirectory() as work:
        jobs = [
            ("cube", lambda: cube_stl(os.path.join(work, "cube.stl")) or os.path.join(work, "cube.stl"), ["#00AE42"]),
            ("bearing4c", lambda: BEARING, ["#FF0000", "#0055FF", "#FFFFFF", "#222222"]),
            ("tower", lambda: tower_stl(os.path.join(work, "tower.stl")) or os.path.join(work, "tower.stl"), ["#2F9BFF"]),
        ]
        for name, model_fn, colours in jobs:
            if only and name not in only:
                continue
            out = os.path.join(FIX, name + ".gcode.3mf")
            slice_model(model_fn(), out, work, colours)
    for name in ("cube", "bearing4c", "tower"):
        p = os.path.join(FIX, name + ".gcode.3mf")
        if os.path.exists(p):
            report(p)


if __name__ == "__main__":
    main()
