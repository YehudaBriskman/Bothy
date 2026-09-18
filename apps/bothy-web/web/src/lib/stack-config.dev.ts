// The stand-in for reading the stack's config files, used by `vite dev` only
// (a dev tab holds no session for bothy-files). The snippets are excerpts of the
// real files at the time of writing - the parsers in stack-config.ts are what is
// being exercised, so the lines they look for are reproduced exactly.
//
//   localStorage['bothy-dev-config-outcome'] = 'signed-out' | 'no-viewer' | 'silence'

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

function refuse(status: number, message: string): never {
  const e = new Error(message) as Error & { status: number };
  e.name = 'ApiError';
  e.status = status;
  throw e;
}

const FILES: Record<string, string> = {
  'monitoring/compose.yml': `services:
  victoriametrics:
    image: victoriametrics/victoria-metrics:v1.152.0
    entrypoint: ["/bin/sh", "-c"]
    command:
      - >-
        exec /victoria-metrics-prod
        -storageDataPath=/victoria-metrics-data
        -retentionPeriod=15d
        -promscrape.config=/etc/prometheus/prometheus.yml
`,
  'monitoring/loki-config.yml': `# ── retention (the only addition) ──
limits_config:
  retention_period: 168h

compactor:
  retention_enabled: true
`,
  'monitoring/provisioning/alerting/rules.yml': `apiVersion: 1

groups:
  - orgId: 1
    name: core-alerts
    folder: Alerts
    interval: 1m
    rules:
      - uid: instance_down
        title: Instance down
        condition: C
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Target {{ $labels.job }} ({{ $labels.instance }}) is DOWN"
      - uid: host_high_memory
        title: Host memory high
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Host memory usage above 90%"
      - uid: host_disk_full
        title: Host disk almost full
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "A filesystem is above 85% full"
  - orgId: 1
    name: cluster-alerts
    folder: Alerts
    interval: 1m
    rules:
      - uid: kube_cluster_down
        title: Kubernetes cluster down
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "thales-scc: scrape job {{ $labels.job }} is DOWN - cluster stopped?"
`,
};

export async function readStackFileMock(path: string): Promise<{ content: string; mtime: number }> {
  await new Promise((r) => setTimeout(r, 200));
  const forced = read('bothy-dev-config-outcome');
  if (forced === 'signed-out') refuse(401, 'sign in to read files');
  if (forced === 'no-viewer') refuse(403, 'Forbidden');
  if (forced === 'silence') refuse(0, 'no answer');
  const content = FILES[path];
  if (content === undefined) refuse(404, 'no such file');
  return { content, mtime: 1_758_000_000 };
}
