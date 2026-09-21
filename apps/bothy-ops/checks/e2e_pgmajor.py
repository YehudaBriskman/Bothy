#!/usr/bin/env python3
"""The Postgres MAJOR (plan kind postgres-major, build step 8) END TO END, on THROWAWAYS. Needs docker.

Run: python3 checks/e2e_pgmajor.py            (about four minutes)

NEVER the live Postgres or its volume. Everything here is its own, and every
name starts with `bothy-pgmajor-e2e`:

  a git repo     a bare "origin" and a clone on main, with its own
                 data/postgres/compose.yml (project bothy-pgmajor-e2e-pg: postgres +
                 an exporter stand-in), auth/compose.yml (bothy-pgmajor-e2e-auth:
                 keycloak-db-init - the LIVE file's script - and a Keycloak
                 stand-in whose health IS reading the keycloak database), a
                 justfile whose up-data runs the REAL scripts/pg-volume-guard.sh,
                 .env and updates.toml (the live postgres entry)
  a network      bothy-pgmajor-e2e-net
  volumes        bothy-pgmajor-e2e-pg_postgres_data (17) and ..._postgres18_data
  state          a temporary state, backups and spool

Postgres 17 (the LIVE pin, by digest) is seeded with a dev database (a table of
1000 rows, one with a quoted name, an empty one), a second database, and a fake
Keycloak schema (realm, user_entity with 3 users). Then main moves to 18 - the
image AND the volume name, in one commit, as the PR for a major must - and:

  1  GUARD        `just up-data` refuses to start 18 on the empty new volume
  2  ASKING       bothy-ops' own request handler: a click and a missing note are
                  refused; the name typed AND a note writes one spool file
  3  PRE-SWITCH   a forced failure at `compare`: the temporary container goes,
                  the old Postgres and the writers start again, the tree is
                  untouched, every row is there; the new volume is KEPT (and the
                  next plan refuses until a person removes it)
  4  POST-SWITCH  a forced failure at `verify`, after compose moved to 18: the
                  old image and the old volume name go back on their lines
                  (uncommitted), Postgres 17 runs on the OLD volume, every row
                  there, the stand-in healthy
  5  SUCCESS      18 on postgres18_data: every database and row count equal to
                  17's, Keycloak's 3 users, keycloak-db-init on 18; the old
                  volume still exists, untouched
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import canaries, executor, hostio, plans, record  # noqa: E402
from updater.config import Config  # noqa: E402

P = "bothy-pgmajor-e2e"
PG_PROJECT, AUTH_PROJECT, NET = f"{P}-pg", f"{P}-auth", f"{P}-net"
PGC, EXP, KDI, KC = f"{P}-pg", f"{P}-exporter", f"{P}-kdi", f"{P}-kc"
OLD_VOL, NEW_VOL = f"{PG_PROJECT}_postgres_data", f"{PG_PROJECT}_postgres18_data"
# Test values only - a throwaway cluster on a throwaway network, gone at the end.
PG_USER, PG_PASS, KC_PASS, DEV_DB = "e2e", "e2e-pg-pass", "e2e-kcdb", "devdb"
LIVE = open(os.path.join(ROOT, "data/postgres/compose.yml"), encoding="utf-8").read()
PG17 = LIVE.split("image: ", 1)[1].split("\n", 1)[0].split()[0]
AUTH_LIVE = open(os.path.join(ROOT, "auth/compose.yml"), encoding="utf-8").read()

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label, flush=True)
    if not cond:
        fails.append(label)


def sh(*argv: str, cwd: str | None = None, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    p = subprocess.run(list(argv), cwd=cwd, capture_output=True, text=True, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv[:6])}: {p.stderr.strip()[-600:] or p.stdout.strip()[-600:]}")
    return p


def compose_pg(image: str, mount: str, key: str) -> str:
    return f"""name: {PG_PROJECT}

services:
  postgres:
    image: {image}
    container_name: {PGC}
    environment:
      POSTGRES_USER: ${{POSTGRES_USER}}
      POSTGRES_PASSWORD: ${{POSTGRES_PASSWORD}}
      POSTGRES_DB: ${{POSTGRES_DB}}
    volumes:
      - {key}:{mount}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${{POSTGRES_USER}}"]
      interval: 2s
      timeout: 3s
      retries: 30
    networks: [testnet]

  exporter:
    image: {PG17}
    container_name: {EXP}
    entrypoint: ["sleep", "infinity"]
    init: true   # so `docker stop` is not a 60 s wait on a PID 1 that ignores SIGTERM
    depends_on:
      postgres:
        condition: service_healthy
    networks: [testnet]

volumes:
  {key}:

networks:
  testnet:
    name: {NET}
    external: true
"""


def compose_auth(image: str) -> str:
    """YAML, like the live file: the updater finds a pin by scanning its lines."""
    block = AUTH_LIVE.split("  keycloak-db-init:", 1)[1].split("\n  # ── 2.", 1)[0]
    command = "    command:\n      - |\n" + block.split("    command:\n      - |\n", 1)[1].split("    deploy:", 1)[0]
    return f"""name: {AUTH_PROJECT}

services:
  keycloak-db-init:
    image: {image}
    container_name: {KDI}
    restart: "no"
    environment:
      PGHOST: {PGC}
      PGUSER: ${{POSTGRES_USER}}
      PGPASSWORD: ${{POSTGRES_PASSWORD}}
      PGDATABASE: ${{POSTGRES_DB}}
      KC_DB_PASSWORD: ${{KEYCLOAK_DB_PASSWORD}}
    entrypoint: ["/bin/bash", "-c"]
{command.rstrip()}
    networks: [testnet]

  # A Keycloak stand-in: healthy while it reaches its database; its canary
  # (users_canary) reads the 3 users.
  keycloak:
    image: {PG17}
    container_name: {KC}
    entrypoint: ["sleep", "infinity"]
    init: true   # so `docker stop` is not a 60 s wait on a PID 1 that ignores SIGTERM
    environment:
      PGHOST: {PGC}
      PGUSER: keycloak
      PGPASSWORD: ${{KEYCLOAK_DB_PASSWORD}}
      PGDATABASE: keycloak
      KC_DB_URL: jdbc:postgresql://{PGC}:5432/keycloak
    healthcheck:
      test: ["CMD-SHELL", "psql -At -c 'SELECT 1'"]
      interval: 2s
      timeout: 3s
      retries: 30
    depends_on:
      keycloak-db-init:
        condition: service_completed_successfully
    networks: [testnet]

networks:
  testnet:
    name: {NET}
    external: true
"""


def users_canary() -> canaries.Canary:
    """The stand-in's canary: it is healthy and reads Keycloak's 3 users - after the
    move exactly as before it."""
    def check(ctx):
        c = hostio.container(KC) or {}
        if c.get("state") != "running" or c.get("health") not in (None, "healthy"):
            return False, f"{KC} is {c.get('state')}/{c.get('health')}"
        p = sh("docker", "exec", KC, "psql", "-At", "-c", "SELECT count(*) FROM user_entity", check=False)
        return p.stdout.strip() == "3", f"user_entity holds {p.stdout.strip() or p.stderr.strip()[:80]}"
    return canaries.Canary("e2e: the Keycloak stand-in is healthy and reads its 3 users", check)


def cleanup() -> None:
    for proj in (AUTH_PROJECT, PG_PROJECT):
        sh("docker", "compose", "-p", proj, "down", "--remove-orphans", check=False)
    names = sh("docker", "ps", "-aq", "--filter", f"name=^{P}", check=False).stdout.split()
    if names:
        sh("docker", "rm", "-f", *names, check=False)
    vols = [v for v in sh("docker", "volume", "ls", "-q", check=False).stdout.split() if v.startswith(P)]
    if vols:
        sh("docker", "volume", "rm", "-f", *vols, check=False)
    sh("docker", "network", "rm", NET, check=False)


def psql(container: str, db: str, sql: str) -> str:
    return sh("docker", "exec", "-e", f"PGPASSWORD={PG_PASS}", container, "psql", "-U", PG_USER, "-X", "-At",
              "-d", db, "-c", sql).stdout.strip()


def snapshot_rows(container: str) -> dict:
    out = {}
    for db, sql in ((DEV_DB, 'SELECT (SELECT count(*) FROM notes), (SELECT count(*) FROM "Odd Table"), '
                              "(SELECT count(*) FROM empty_one), (SELECT sum(id) FROM notes)"),
                    ("wiki", "SELECT count(*) FROM pages"),
                    ("keycloak", "SELECT (SELECT count(*) FROM user_entity), (SELECT count(*) FROM realm)")):
        out[db] = psql(container, db, sql)
    return out


def main() -> int:
    tmp = tempfile.mkdtemp(prefix=f"{P}-")
    os.environ["E2E_TMP"] = tmp
    had18 = None
    try:
        cleanup()
        repo, origin = os.path.join(tmp, "repo"), os.path.join(tmp, "origin.git")
        G = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
        sh("git", "init", "-q", "--bare", "-b", "main", origin)
        sh("git", "clone", "-q", origin, repo)
        sh(*G, "checkout", "-q", "-b", "main", cwd=repo)

        def put(rel: str, text: str) -> None:
            p = os.path.join(repo, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").write(text)

        def merge(msg: str) -> None:
            sh(*G, "add", "-A", cwd=repo)
            sh(*G, "commit", "-q", "-m", msg, cwd=repo)
            sh(*G, "push", "-q", "origin", "main", cwd=repo)

        cat = open(os.path.join(SVC, "updates.toml"), encoding="utf-8").read()
        policy = cat[cat.index("[policy]"):cat.index("# ══ stateless")]
        comp = cat[cat.index("[components.postgres]"):]
        put("apps/bothy-ops/updates.toml", policy + comp)
        put(".env", f"POSTGRES_USER={PG_USER}\nPOSTGRES_PASSWORD={PG_PASS}\nPOSTGRES_DB={DEV_DB}\n"
                    f"KEYCLOAK_DB_PASSWORD={KC_PASS}\n")
        put(".gitignore", ".env\n")
        guard = os.path.join(ROOT, "scripts", "pg-volume-guard.sh")
        put("justfile", "set dotenv-load\n\nup-data:\n"
                        f"    bash {guard} data/postgres/compose.yml postgres\n"
                        "    docker compose -f data/postgres/compose.yml up -d --wait --wait-timeout 120\n\n"
                        "up-auth:\n    docker compose -f auth/compose.yml up -d --wait --wait-timeout 120\n")
        put("data/postgres/compose.yml", compose_pg(PG17, "/var/lib/postgresql/data", "postgres_data"))
        put("auth/compose.yml", compose_auth(PG17))
        merge("postgres 17")
        sh("docker", "network", "create", NET)
        t0 = time.monotonic()
        j = ["just", "--justfile", os.path.join(repo, "justfile"), "--working-directory", repo]
        sh(*j, "up-data", cwd=repo)
        sh(*j, "up-auth", cwd=repo)
        print(f"  (postgres 17 and the stand-ins up in {int(time.monotonic() - t0)}s)", flush=True)

        # Seed: a dev database, a second one, a fake Keycloak schema.
        psql(PGC, DEV_DB, 'CREATE TABLE notes (id int PRIMARY KEY, body text); '
                          "INSERT INTO notes SELECT g, 'row ' || g || E'\\nwith a newline' FROM generate_series(1, 1000) g; "
                          'CREATE TABLE "Odd Table" (x int); INSERT INTO "Odd Table" VALUES (1), (2); '
                          "CREATE TABLE empty_one (x int)")
        psql(PGC, "postgres", "CREATE DATABASE wiki")
        psql(PGC, "wiki", "CREATE TABLE pages (t text); INSERT INTO pages VALUES ('home'), ('about')")
        psql(PGC, "keycloak", "SET ROLE keycloak; CREATE TABLE realm (id text PRIMARY KEY, name text); "
                              "INSERT INTO realm VALUES ('r1', 'devbox'); "
                              "CREATE TABLE user_entity (id text PRIMARY KEY, username text, realm_id text); "
                              "INSERT INTO user_entity VALUES ('u1', 'alice', 'r1'), ('u2', 'bob', 'r1'), "
                              "('u3', 'carol', 'r1')")
        before = snapshot_rows(PGC)
        ok(before[DEV_DB] == "1000|2|0|500500" and before["keycloak"] == "3|1", f"17 seeded: {before}")

        # The major, as its PR must be: the image AND the volume name, both pins.
        pull = sh("docker", "image", "inspect", "postgres:18", check=False)
        had18 = pull.returncode == 0
        sh("docker", "pull", "-q", "postgres:18")
        dg = next(d.split("@", 1)[1] for d in json.loads(sh("docker", "image", "inspect", "postgres:18").stdout)[0]
                  ["RepoDigests"] if d.startswith("postgres@"))
        ver = re.search(r"(\d+\.\d+)", sh("docker", "run", "--rm", "postgres:18", "postgres", "--version").stdout).group(1)
        PG18 = f"postgres:{ver}@{dg}"
        put("data/postgres/compose.yml", compose_pg(PG18, "/var/lib/postgresql", "postgres18_data"))
        put("auth/compose.yml", compose_auth(PG18))
        merge(f"postgres {ver}: new image AND new volume, both pins")

        print("── 1  GUARD: `just up-data` will not start 18 on an empty volume ─", flush=True)
        g = sh(*j, "up-data", cwd=repo, check=False)
        ok(g.returncode != 0 and "REFUSING" in g.stderr and "postgres18_data" in g.stderr,
           "refused, and it says why and what to do")
        ok(hostio.container(PGC)["image"] == PG17 and sh("docker", "volume", "inspect", NEW_VOL, check=False).returncode,
           "…and nothing moved: 17 still runs, no new volume was created")

        state, backups = os.path.join(tmp, "state"), os.path.join(tmp, "backups")
        os.makedirs(os.path.join(backups, "postgres"))
        open(os.path.join(backups, "postgres", "pg-e2e.sql.gz"), "w").write("a nightly stand-in")
        cfg = Config(repo=repo, catalog=os.path.join(repo, "apps/bothy-ops/updates.toml"), state=state,
                     backups=backups, textfile=None, pg_stop=(KC, EXP), pg_start=("up-auth",), pg_keycloak=KC,
                     canaries={"keycloak": [users_canary()]}, verify_timeout=90, min_free_bytes=1 << 20)

        def discover() -> None:
            hostio.ensure_dir(state, 0o700)
            hostio.write_json(cfg.available, {"version": 1, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                              "components": {"postgres": {
                                                  "image": "docker.io/library/postgres",
                                                  "current": {"tag": ver, "digest": dg, "float": True}}}})
            plans.write_all(cfg)

        discover()
        pd = plans.read_plan(cfg, "postgres")
        ok(pd["ok"] and pd["plan"]["kind"] == "postgres-major" and pd["plan"]["pgMajor"]["newVolume"] == NEW_VOL,
           f"the plan: postgres-major, {pd.get('plan', {}).get('from', {}).get('version')} -> {ver} on {NEW_VOL}"
           if pd["ok"] else f"the plan: {pd.get('reason')}")
        if not pd["ok"]:
            return 1

        print("── 2  ASKING: bothy-ops' own handler - typed AND noted ──────────", flush=True)
        os.environ.update(UPDATES_DIR=state, UPDATES_SPOOL=cfg.spool, UPDATES_AVAILABLE=cfg.available,
                          ADMIN_AUDIT_LOG=os.path.join(tmp, "admin.log"))
        hostio.ensure_dir(cfg.spool, 0o700)
        import importlib
        import updates
        importlib.reload(updates)
        updates.CATALOG = updates.load(cfg.catalog)

        class H:
            def __init__(self, body: dict) -> None:
                self.body = body

            def read_json_object(self, _max: int) -> dict:
                return self.body

        def request(**body) -> str:
            pid = plans.read_plan(cfg, "postgres")["plan"]["id"]
            return updates.request_update(H({"component": "postgres", "plan_id": pid, **body}), "op@example.com")[0]["jobId"]

        for body, label in (({"confirm": True, "note": "a click with a note"}, "a click"),
                            ({"confirm": "postgres"}, "the name typed, no note")):
            try:
                request(**body)
                ok(False, f"{label} is refused (a file was WRITTEN)")
            except Exception as e:  # noqa: BLE001 - Refused
                ok(os.listdir(cfg.spool) == [], f"{label} is refused, no file ({e})")
        NOTE = "e2e: moving the throwaway to 18, nobody else uses it"

        def run(force: str | None) -> dict:
            discover()
            cfg.pg_force_fail = force
            jid = request(confirm="postgres", note=NOTE)
            t = time.monotonic()
            executor.run_spool(cfg, log=lambda *_: None)
            h = next(x for x in record.history(cfg, 20) if x["id"] == jid)
            print(f"  (job {jid[:8]}: {h['state']} in {int(time.monotonic() - t)}s)", flush=True)
            return h

        print("── 3  PRE-SWITCH failure: compare fails, nothing moved ──────────", flush=True)
        h = run("compare")
        st = hostio.read_json(cfg.status_file)["job"]
        steps = {s["name"]: s["state"] for s in st["steps"]}
        ok(h["state"] == "rolled_back" and steps.get("compare") == "failed" and steps.get("switch") == "skipped",
           f"rolled_back at compare, never switched: {steps}")
        ok(steps.get("stop") == "ok" and steps.get("dump") == "ok" and steps.get("load") == "ok",
           "…after the writers stopped, the dump and the load")
        ok(hostio.container(PGC)["image"] == PG17 and snapshot_rows(PGC) == before,
           "17 runs on the OLD volume again, every row there")
        ok((hostio.container(KC) or {}).get("health") == "healthy" and (hostio.container(EXP) or {}).get("state")
           == "running", "the writers are back")
        ok(sh(*G, "status", "--porcelain", cwd=repo).stdout.strip() == "", "the tree was never touched")
        ok(sh("docker", "ps", "-aq", "--filter", f"name={PGC}-major", check=False).stdout.strip() == "",
           "the temporary container is gone")
        ok(sh("docker", "volume", "inspect", NEW_VOL, check=False).returncode == 0 and
           "docker volume rm" in (h.get("note") or ""), "the new volume is KEPT, and the note says how to remove it")
        discover()
        ok("already exists" in (plans.read_plan(cfg, "postgres").get("reason") or ""),
           "the next plan refuses until a person has looked at it")
        sh("docker", "volume", "rm", NEW_VOL)

        print("── 4  POST-SWITCH failure: back to the OLD volume ────────────────", flush=True)
        h = run("verify")
        st = hostio.read_json(cfg.status_file)["job"]
        steps = {s["name"]: s["state"] for s in st["steps"]}
        ok(h["state"] == "rolled_back" and steps.get("switch") == "ok" and steps.get("verify") == "failed",
           f"switched to 18, then rolled back at verify: {steps}")
        c = hostio.container(PGC)
        mounts = [m["Name"] for m in json.loads(sh("docker", "inspect", PGC).stdout)[0]["Mounts"] if m["Type"] == "volume"]
        ok(c["image"] == PG17 and mounts == [OLD_VOL], f"Postgres 17 runs on the OLD volume: {c['image'][:30]} {mounts}")
        ok(snapshot_rows(PGC) == before, "every row is there - the old volume was never touched")
        diff = sh(*G, "diff", "--stat", cwd=repo).stdout
        dd = sh(*G, "diff", cwd=repo).stdout
        ok("postgres_data:/var/lib/postgresql/data" in dd and f"image: {PG17}" in dd and "  postgres_data:" in dd
           and "auth/compose.yml" in diff, "the old image, mount and volume declaration are back on their lines, "
                                           "both files, uncommitted")
        ok((hostio.container(KDI) or {}).get("image") == PG17 and (hostio.container(KC) or {}).get("health")
           == "healthy", "keycloak-db-init is back on 17; the stand-in reads its users")
        ok("git checkout" in (h.get("note") or "") and "not in the old volume" in (h.get("note") or ""),
           "the note says what is uncommitted and what was lost")
        discover()
        ok("local changes" in (plans.read_plan(cfg, "postgres").get("reason") or ""),
           "the plan refuses until a person resets the tree")
        sh(*G, "checkout", "-q", "--", ".", cwd=repo)
        sh("docker", "volume", "rm", NEW_VOL)

        print("── 5  SUCCESS: 18 on postgres18_data ────────────────────────────", flush=True)
        h = run(None)
        ok(h["state"] == "succeeded", f"succeeded ({h.get('error') or ''})")
        c = hostio.container(PGC)
        mounts = [m["Name"] for m in json.loads(sh("docker", "inspect", PGC).stdout)[0]["Mounts"] if m["Type"] == "volume"]
        ok(c["image"] == PG18 and mounts == [NEW_VOL], f"Postgres {ver} runs on {mounts}")
        ok(psql(PGC, "postgres", "SHOW server_version").startswith(ver.split(".")[0] + "."), "the server says 18")
        ok(snapshot_rows(PGC) == before, f"every database and row equal to 17's: {snapshot_rows(PGC)}")
        ok((hostio.container(KDI) or {}).get("image") == PG18, "keycloak-db-init runs 18 too (the major rule)")
        ok((hostio.container(KC) or {}).get("health") == "healthy", "the Keycloak stand-in reads its 3 users")
        ok(sh("docker", "volume", "inspect", OLD_VOL, check=False).returncode == 0
           and f"docker volume rm {OLD_VOL}" in (h.get("note") or ""),
           "the OLD volume still exists; deleting it is a separate manual command")
        ok(sh(*G, "status", "--porcelain", cwd=repo).stdout.strip() == "", "the tree is clean: main pins what runs")
        snaps = sorted(os.listdir(cfg.snapshots))
        sd = os.path.join(cfg.snapshots, snaps[-1]) if snaps else ""
        counts = json.load(open(os.path.join(sd, "counts.json"))) if sd else {}
        ok(counts.get("tables", {}).get(DEV_DB, {}).get("public.notes") == 1000 and
           counts.get("tables", {}).get("keycloak", {}).get("public.user_entity") == 3,
           "the snapshot holds the dump and its row counts")
        g = sh(*j, "up-data", cwd=repo, check=False)
        ok(g.returncode == 0, "and `just up-data` now passes the guard (the volume exists)")
    finally:
        cleanup()
        if had18 is False:
            sh("docker", "image", "rm", "postgres:18", check=False)
        shutil.rmtree(tmp, ignore_errors=True)
    left = sh("docker", "ps", "-aq", "--filter", f"name={P}", check=False).stdout.strip()
    ok(not left and not [v for v in sh("docker", "volume", "ls", "-q").stdout.split() if v.startswith(P)],
       "cleanup: no container, volume or network of this test is left")
    print()
    if fails:
        print(f"FAILED: {len(fails)}")
        return 1
    print("postgres-major e2e: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
