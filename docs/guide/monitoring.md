# Monitoring

Every container on this box is covered - logs and metrics - with **no
per-service setup**. That is not a claim about how thorough the configuration
is; it is a consequence of how two of the three collectors find their targets.

## Why it covers everything for free

| Signal | Collector | Coverage |
|---|---|---|
| Logs | `promtail`, via Docker service discovery, into Loki | every running container, any stack or project. Labels: `container`, `stack` (the compose project), `stream` |
| Container metrics | `cadvisor` into Prometheus | CPU, memory, network and filesystem, every container |
| Host metrics | `node-exporter` | |
| App metrics | `postgres-exporter` | |
| The edge | Traefik's own Prometheus metrics | request rate, latency and error rate per router, service and entrypoint |

`promtail` and `cadvisor` discover through the Docker socket rather than a
hand-kept target list. **A container you start is covered the moment it starts**,
and a container you delete stops being scraped without anyone editing anything.

Traefik's metrics are on an **internal** entrypoint with no host port -
Prometheus reaches it by name over `devnet`. That is why a new service only has
to join `devnet` to be visible; see [Adding a service](services.md).

## What you get in Grafana

Grafana auto-provisions the Prometheus and Loki datasources, five dashboards,
and three alert rules:

| Alert | Fires when |
|---|---|
| Instance down | a Prometheus target stops answering |
| Host memory high | host memory above 90% |
| Host disk almost full | a filesystem above 85% full |

Everything is provisioned from files under `monitoring/provisioning/`, so a
dashboard edited in the Grafana UI is **not** persisted the way a provisioned
one is. Edit the file.

## Retention, and the two limits that matter

**Prometheus: 15 days, and 3 GB, whichever comes first.**

The size ceiling is the interesting half, and it exists because of a real
incident. `retention.time` alone means the volume grows as
`cardinality x 15 days` - bounded by how much things happen to emit rather than
by anything anyone chose. cAdvisor ran with no flags, produced 4,147 series of
which ~400 were reachable, and that is most of why the volume reached 1.8 GB.

Time-based retention was working correctly the whole time. The defect was never
that old data stayed; it was that nothing capped how big fifteen days could
**be**. If the size limit ever bites, it means something started emitting far
more than before, and losing the oldest hours is the right answer.

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

Prometheus and Grafana publish their own host ports; `just urls` prints the
table for the box you are on. Neither is behind single sign-on. Prometheus
carries HTTP basic auth on **all** endpoints as its boundary, and Grafana its
own login, both on the shared `DEV_LOGIN_*` credential from `.env`.

> [!warning] "SSO is running" does not mean "this is behind SSO"
> Only three tiers are. Grafana, Prometheus and Keycloak's own console each
> carry a separate login, and the tailnet is the rest of the control. See
> [Roles](roles.md).

## What to look at first

- **`just doctor`** covers Prometheus targets alongside containers, ports,
  routes, DNS and disk, and is the fastest way to see that a collector has
  stopped. [Troubleshooting](troubleshooting.md) reads its output.
- **Logs for one container** are a Loki query on the `container` label, and
  because promtail discovers by socket, the label is the container's real name
  with no configuration anywhere.
- **The Overview in the console** reads the same Prometheus - the CPU, memory
  and network panels are queries, not a second collector.

## Related

- [Adding a service to the stack](services.md) - what joining `devnet` gets you
- [Backups](backups.md) - what is and is not preserved (metrics are not)
- [Troubleshooting](troubleshooting.md) - `just doctor`, and what its sections mean
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) - the collectors in their full context
