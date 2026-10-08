# Monitoring

Every container on this box is covered - logs and metrics - with **no
per-service setup**. That is not a claim about how thorough the configuration
is; it is a consequence of how two of the three collectors find their targets.

## Why it covers everything for free

| Signal | Collector | Coverage |
|---|---|---|
| Logs | `alloy`, via Docker service discovery, into Loki | every running container, any stack or project. Labels: `container`, `stack` (the compose project), `stream` |
| Container metrics | `cadvisor` into VictoriaMetrics | CPU, memory and network, every container |
| Host metrics | `node-exporter` | including the textfile collector, which is how metrics a **host** program writes reach the database with no scrape target of their own |
| App metrics | `postgres-exporter` | |
| The edge | Traefik's own Prometheus metrics | request rate, latency and error rate per router, service and entrypoint |

`alloy` and `cadvisor` discover through the Docker socket rather than a
hand-kept target list. **A container you start is covered the moment it starts**,
and a container you delete stops being scraped without anyone editing anything.

Traefik's metrics are on an **internal** entrypoint with no host port -
VictoriaMetrics reaches it by name over `devnet`. That is why a new service only
has to join `devnet` to be visible; see [Adding a service](services.md).

## What you get in Grafana

Grafana auto-provisions the Prometheus and Loki datasources, five dashboards,
and eight alert rules in three groups:

| Group | Alert | Fires when |
|---|---|---|
| core | Instance down | a scrape target stops answering for 2 minutes |
| core | Host memory high | host memory above 90% |
| core | Host disk almost full | a filesystem above 85% full |
| cluster | Kubernetes cluster down | any `kube*` target down for 5 minutes |
| cluster | Kubernetes node NotReady | the kubelet reports NotReady |
| update | Update rolled back or failed | a component's last update job did not succeed |
| update | Automatic updates paused | the night job will not touch a component until a person clears it |
| update | Update waiting for over 14 days | a patch or minor has been on offer for a fortnight |

Everything is provisioned from files under `monitoring/provisioning/`, so a
dashboard edited in the Grafana UI is **not** persisted the way a provisioned
one is. Edit the file.

## What you see first

**Box health** (`monitoring/dashboards/box-health.json`) is the landing page, set
by `GF_USERS_DEFAULT_HOME_DASHBOARD_PATH` in `monitoring/compose.yml`. Before it,
Grafana opened on its stock "Welcome to Grafana" page - a tutorial carousel and an
invitation to add a datasource, on a box with two of them.

It is six panels in one screen, and the test each one had to pass was **what
question does this answer that nothing else here answers**:

| Panel | The question only it answers |
|---|---|
| Alerts firing | is anything wrong that a rule already knows about |
| Scrape targets, as a timeline | has a target been *flapping* - `instance_down` needs two full minutes, so a target that bounces every ninety seconds pages nobody |
| Host headroom | how close to the memory and disk alerts are we, measured with those alerts' own expressions |
| Log lines per second | is the **log** pipeline alive - Alloy can stop shipping while every container stays healthy, and nothing alerts on it |
| Updates | pins drifted from what the repository pins, and components discovery could not check. Neither has an alert. `bothy_update_config_drift` - the image matches and the merged compose configuration does not - is exported beside them and is on no panel yet either |
| How current this is | how long since the host booted, and since the updater last wrote - the numbers to its left are read out of that file |

Three things are **deliberately not on it**, and the reasons are the useful part:

- **"N of M containers running."** M does not exist in metrics. The portal knows
  which services are *meant* to be up; Grafana only knows which ones emit. A
  fraction with an invented denominator is the failure
  [dataviz](../brand/patterns/dataviz.md) records twice.
- **Per-container CPU and memory.** That is the Cadvisor dashboard and the portal
  Overview, and neither is one glance.
- **A Loki dashboard.** Explore already *is* the log tool, with a query bar and a
  label browser; a page of log panels is a worse Explore. The one durable Loki
  question - are lines still arriving - is a panel on the summary instead.

## The dashboards, and which standard each is held to

[dataviz](../brand/patterns/dataviz.md) is the standard. Only two of the five can
be held to all of it, and that split is explicit rather than accidental.

| Dashboard | Panels | Origin | Held to |
|---|---|---|---|
| Box health | 6 | written here | all of it |
| Traefik - edge | 8 | written here | all of it |
| Cadvisor exporter | 10 | grafana.com 193 | the mechanical rules |
| PostgreSQL Database | 35 | grafana.com 455 | the mechanical rules |
| Node Exporter Full | 140 | grafana.com 1860 | the mechanical rules |

**Why the imports are not rewritten.** An upstream dashboard carries knowledge
about its exporter that a hand rewrite throws away, and it is re-importable as a
clean *replace* only as long as nobody has hand-edited it. So the mechanical half
of the standard is a script - `just dash-normalise` - and the workflow is: drop
the new export in, run it, read the diff, commit. `scripts/checks/dashboards.sh`
runs the same rules with `--check` in CI, and a sixth dashboard that is filed as
neither hand-written nor upstream **fails** it, because the quiet way a standard
rots is a file nobody classified.

**What the script changes, and why each one is a defect rather than a preference:**

- **Colour by entity, not by rank.** 110 panels of Node Exporter Full used
  `palette-classic`, which assigns a colour by a series' *index* - so filtering
  out one mount repainted every mount after it in the list.
- **Gaps are gaps.** The Cadvisor import drew a missing sample as *zero* on its
  CPU and both memory panels, which is a cliff that never happened, on exactly
  the panels you open when a container is behaving oddly.
- **A colour ladder nothing can move is removed.** `Pressure` is `percentunit`
  with `max: 1` and thresholds at 70 and 90 - 7000% and 9000% - so a PSI bargauge
  had been permanently green since the day it was imported. `Speed` and `MTU` had
  a single green step and no threshold at all.
- **One of everything else:** one datasource syntax (the imports had three
  spellings of the same datasource), one refresh interval, `timezone: browser` so
  two dashboards mean the same instant, a shared crosshair, no datasource picker
  on a provisioned dashboard, and no `__inputs` envelope once nothing is left for
  the import wizard to fill.

**One rule refuses to auto-fix:** a series drawn against a second y-axis. The fix
is to *split* the panel, which is a judgement about what the two halves are for.
It happens to be true of all five dashboards already; the check keeps it that way.

**What is deliberately left broken in the imports**, so nobody re-opens it:

- **The old panel vocabulary.** `singlestat` and `graph` are gone from Grafana,
  and Grafana 13 migrates them at *load* time - so the colours and units of those
  panels come out of the migrator, not out of the file. Writing a modern
  `fieldConfig` there would either be a no-op that looks like a fix or a collision
  with the migrator.
- **Threshold numbers somebody typed that are nonsense anyway.** `RootFS Total`
  turns red above 70 **bytes**. A typed number cannot be proven unintended, and a
  hand edit to an import is lost on the next re-import.
- **Grafana's own categorical palette** rather than the validated five-slot one in
  [colour](../brand/foundations/colour.md). Grafana has no per-dashboard palette,
  and pinning a colour per series name rots the moment a route or a mount is
  renamed. The rule that *is* enforced is by-entity rather than by-rank, which is
  the one that causes misreading.
- **PostgreSQL Database's Kubernetes lineage.** Its `namespace` and `release`
  variables are extracted by regex from labels a Helm-deployed exporter sets and
  this box's compose exporter does not, so both read as empty - and `$instance`
  resolves only because an empty-string matcher happens to match an absent label.
  It works; it works by accident. Rewriting it is a rewrite, not a normalisation.

## Retention, and the two limits that matter

**VictoriaMetrics: 15 days.** There is no size ceiling, because VM has no
equivalent of Prometheus' `--storage.tsdb.retention.size`: it drops whole data
parts once they are entirely outside the window, so the disk can briefly hold more
than fifteen days. At roughly 20 MB a day that is not a problem, and
`-storage.minFreeDiskSpaceBytes` makes it stop *writing* rather than fill the
disk. **Fifteen days bounds what any dashboard can honestly show** - which is why
the `update_stale` alert looks back thirteen days and not thirty.

Prometheus held the same fifteen days behind a 3 GB ceiling, and the ceiling
existed because of a real incident: `retention.time` alone means the volume grows
as `cardinality x 15 days`, bounded by how much things happen to emit rather than
by anything anyone chose. cAdvisor ran with no flags, produced 4,147 series of
which ~400 were reachable, and that is most of why the volume reached 1.8 GB. The
flag trim in `monitoring/compose.yml` took that to 1,036 series, which is why the
missing ceiling is not the same risk it was.

**Loki: 168 hours (7 days).** Loki ships with no retention whatsoever - the
stock configuration defines neither a limit nor a compactor that would enforce
one - so both stanzas had to be added. Everything else in `loki-config.yml` is
the image default, verbatim, which is deliberate: it makes the diff against
upstream exactly "the retention block".

## A scrape job for something that does not run is not harmless

Two jobs were removed when their services were, and the reasoning is worth
carrying into anything you add:

- `redis-exporter` and `kafka-exporter` came out when those services did.
- The `docker-daemon` job came out because nothing in the repository read a
  single `engine_daemon_*` series, and because the daemon setting that produces
  them is opt-in - so the target sat permanently down on any box that had not
  been hand-edited.

A permanently-down target does not just add noise. It destroys the usefulness of
the only question worth asking of a target list: **are all targets up?** Once
the answer is routinely "no, but that one is fine", nobody reads it again.

So: **deleting a service means deleting its scrape job in the same change.** The
same rule applies to backup steps, and this repository has broken that one twice
- see [Backups](backups.md).

## Reaching it

VictoriaMetrics and Grafana publish their own host ports; `just urls` prints the
table for the box you are on. Neither is behind single sign-on. VictoriaMetrics
carries HTTP basic auth on **all** endpoints as its boundary (`-httpAuth.*`), and
Grafana its own login, both on the shared `DEV_LOGIN_*` credential from `.env`.

> [!warning] "SSO is running" does not mean "this is behind SSO"
> Only 5 tiers are behind single sign-on. Grafana, VictoriaMetrics and
> Keycloak's own console each carry a separate login, and the tailnet is the rest
> of the control. See [Roles](roles.md).

## What to look at first

- **Grafana's landing page**, Box health, is built to be the answer to "is the
  box well?" in one screen. Start there rather than at a dashboard list.
- **`just doctor`** covers scrape targets alongside containers, ports, routes,
  DNS and disk, and is the fastest way to see that a collector has stopped.
  [Troubleshooting](troubleshooting.md) reads its output.
- **Logs for one container** are a Loki query on the `container` label, and
  because Alloy discovers by socket, the label is the container's real name
  with no configuration anywhere. Use **Explore**, not a dashboard: there is
  deliberately no log dashboard here, because Explore is the better instrument.
- **The Overview in the console** reads the same database - the CPU, memory
  and network panels are queries, not a second collector.

## Related

- [Adding a service to the stack](services.md) - what joining `devnet` gets you
- [Backups](backups.md) - what is and is not preserved (metrics are not)
- [Troubleshooting](troubleshooting.md) - `just doctor`, and what its sections mean
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) - the collectors in their full context
