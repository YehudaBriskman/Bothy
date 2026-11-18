#!/usr/bin/env python3
"""e2e_updater.py is split into parts that CI runs as parallel jobs. Hold the split.

A section that sits in no part never runs in CI and nothing says so; one that sits
in two runs twice and the job that carries it is slower for it. So:

  - every `── N.` section header in e2e_updater.py is inside exactly one
    `if PART in (...)` block, and the blocks name different parts;
  - every section the docstring lists exists, and every section that exists is listed;
  - run.sh runs exactly the parts the script defines - each once, by `--part=X` -
    and never the script bare (which would run everything again in one job).

Run: python3 checks/test_e2e_parts.py     (offline, no docker)
"""
import ast
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SUITE = os.path.join(HERE, "e2e_updater.py")
RUNSH = os.path.join(HERE, "run.sh")
fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


src = open(SUITE).read()
tree = ast.parse(src)

HEAD = re.compile(r"^── (\d+)\. ")


def headers(node: ast.AST) -> list[int]:
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "print" and n.args \
                and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str):
            m = HEAD.match(n.args[0].value)
            if m:
                out.append(int(m.group(1)))
    return out


blocks: dict[str, list[int]] = {}
for n in ast.walk(tree):
    if isinstance(n, ast.If) and isinstance(n.test, ast.Compare) and getattr(n.test.left, "id", "") == "PART" \
            and isinstance(n.test.comparators[0], ast.Tuple):
        names = [e.value for e in n.test.comparators[0].elts if isinstance(e, ast.Constant)]
        part = [x for x in names if x != "all"]
        if len(part) == 1 and "all" in names:
            blocks.setdefault(part[0], []).extend(headers(n))

every = headers(tree)
inparts = [s for v in blocks.values() for s in v]
ok(len(blocks) >= 2, f"the suite defines {sorted(blocks)} as parts")
ok(len(every) >= 7, f"{len(every)} section headers found")
ok(sorted(inparts) == sorted(every),
   f"every section header is inside exactly one part: in parts {sorted(inparts)}, in the file {sorted(every)}")
ok(len(set(inparts)) == len(inparts), "no section is in two parts")

doc = ast.get_docstring(tree) or ""
documented = sorted(int(m) for m in re.findall(r"^  (\d)  [A-Z]", doc, re.M))
ok(documented == sorted(set(every)), f"the docstring lists sections {documented}, the code has {sorted(set(every))}")

runsh = open(RUNSH).read()
used = re.findall(r"^e2e\s+\S+\s+\"[^\"]*\"\s+e2e_updater\.py(.*)$", runsh, re.M)
parts_run = sorted(re.sub(r"^\s*--part=", "", u).strip() for u in used if u.strip().startswith("--part="))
ok(len(used) == len(parts_run), f"run.sh never runs e2e_updater.py bare: {used}")
ok(parts_run == sorted(blocks), f"run.sh runs parts {parts_run}, the suite defines {sorted(blocks)}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("e2e_updater parts: all passed")
