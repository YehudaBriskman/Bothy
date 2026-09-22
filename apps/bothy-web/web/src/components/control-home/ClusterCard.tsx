// The cluster at a glance: the node, the pods, the restarts, and the two
// namespaces bothy-ops acts on, each linking to its own view of /control/cluster.
// Read from kube-state-metrics through Prometheus - see sources.ts for why not
// the kube reads.

import { Link } from 'react-router-dom';
import { ShipWheel } from 'lucide-react';
import { KUBE_NAMESPACES } from '../../lib/kube-actions';
import type { CollectorProject } from '../../lib/projects';
import type { Source } from './usePolled';
import type { ClusterMetrics } from './sources';
import { Card, Fact, SourceNote, ToneIcon } from './parts';

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

export function ClusterCard({ src, projects }: { src: Source<ClusterMetrics>; projects: CollectorProject[] }) {
  const c = src.data;
  // The collector knows whether a cluster PROJECT is live even when nothing
  // scrapes it - the difference between "the cluster is off" and "it is on and
  // unmonitored", which a card that just said "no data" would blur.
  const declared = projects.filter((p) => p.kind === 'cluster');
  const declaredLive = declared.some((p) => p.state === 'live' || p.state === 'degraded');

  return (
    <Card id="ch-cluster" title="Cluster" icon={ShipWheel} to="/control/cluster" toLabel="Cluster">
      {!c ? (
        <SourceNote state={src.state} what="cluster metrics" />
      ) : !c.reporting ? (
        <p className="ch-empty">
          <ToneIcon tone="off" label="Not reporting" />{' '}
          {declaredLive
            ? 'The collector sees cluster workloads running, but kube-state-metrics is not reporting them.'
            : 'No cluster is reporting. Start it with minikube, and its node and pods appear here.'}
        </p>
      ) : (
        <>
          <dl className="ch-facts">
            <Fact label="Node">
              <span className="ch-inline">
                <ToneIcon tone={c.nodeReady ? 'ok' : 'bad'} label={c.nodeReady ? 'Ready' : 'Not ready'} />
                <span className="mono">{c.node}</span>
                <span className="ch-dim">{c.nodeReady ? 'Ready' : 'Not ready'}</span>
              </span>
            </Fact>
            <Fact label="Pods ready" to="/control/cluster?tab=pods">
              <span className="ch-num">{sum(c.readyByNs)}</span> / {sum(c.livePodsByNs)}
            </Fact>
            <Fact label="Restarts, 24h">
              <span className="ch-num">{c.restarts24h ?? '-'}</span>
            </Fact>
            <Fact label="Namespaces">
              <span className="ch-num">{c.namespaces.length}</span>
            </Fact>
          </dl>
          <h3 className="eyebrow ch-sub-h">Acted on by Bothy</h3>
          <ul className="ch-rows">
            {KUBE_NAMESPACES.map((ns) => {
              const exists = c.namespaces.includes(ns);
              const pods = c.podsByNs[ns] ?? 0;
              const live = c.livePodsByNs[ns] ?? 0;
              const ready = c.readyByNs[ns] ?? 0;
              const tone = !exists ? 'off' : pods === 0 ? 'warn' : ready < live ? 'warn' : 'ok';
              const word = !exists ? 'absent' : pods === 0 ? 'no workloads' : `${ready} / ${live} ready`;
              return (
                <li key={ns}>
                  <Link className="ch-row" to={`/control/cluster?ns=${encodeURIComponent(ns)}`}>
                    <ToneIcon tone={tone} label={word} />
                    <span className="ch-row-name mono">{ns}</span>
                    <span className="ch-row-val" aria-hidden="true">{word}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {src.state === 'error' && <SourceNote state="error" what="a fresh reading" />}
        </>
      )}
    </Card>
  );
}
