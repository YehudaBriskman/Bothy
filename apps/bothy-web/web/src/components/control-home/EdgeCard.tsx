// The edge at a glance: how many routers Traefik is serving, how many answered
// 5xx in the last five minutes, the request rate over the last hour, and the
// busiest routes now. Router counts come from the shared poll (lib/api.ts); the
// traffic comes from Traefik's own metrics through Prometheus.

import { Link } from 'react-router-dom';
import { Waypoints } from 'lucide-react';
import type { RouteCounts } from '../../pages/control/home';
import type { Source } from './usePolled';
import type { EdgeMetrics } from './sources';
import { Card, Fact, SourceNote, Sparkline, ToneIcon } from './parts';

const fmtRps = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3));

export function EdgeCard({ counts, src }: { counts: RouteCounts; src: Source<EdgeMetrics> }) {
  const e = src.data;
  const now = e?.rps?.points.at(-1)?.v ?? null;
  return (
    <Card id="ch-edge" title="Edge and routes" icon={Waypoints} to="/control/routes" toLabel="Routes">
      <dl className="ch-facts">
        <Fact label="Routers enabled" to="/control/routes">
          <span className="ch-num">{counts.enabled}</span> / {counts.total}
        </Fact>
        <Fact label="Need a look" to="/control/routes">
          <span className="ch-inline">
            <ToneIcon tone={counts.problems ? 'warn' : 'ok'} label={counts.problems ? 'Needs a look' : 'OK'} />
            <span className="ch-num">{counts.problems}</span>
          </span>
        </Fact>
        {e && (
          <>
            <Fact label="5xx, last 5m">
              <span className="ch-inline">
                <ToneIcon tone={e.errors5m ? 'bad' : 'ok'} label={e.errors5m ? 'Errors' : 'No errors'} />
                <span className="ch-num">{e.errors5m ?? '-'}</span>
              </span>
            </Fact>
            <Fact label="Requests now">
              <span className="ch-num">{now == null ? '-' : fmtRps(now)}</span> req/s
            </Fact>
          </>
        )}
      </dl>
      {!e ? (
        <SourceNote state={src.state} what="edge traffic" />
      ) : (
        <>
          <Sparkline
            series={e.rps}
            label={`Requests per second across every router, the last hour${now == null ? '' : `; now ${fmtRps(now)}`}`}
          />
          <h3 className="eyebrow ch-sub-h">Busiest routes now</h3>
          {e.top.length === 0 ? (
            <p className="ch-empty">No traffic in the last five minutes.</p>
          ) : (
            <ul className="ch-rows">
              {e.top.map((r) => (
                <li key={r.router}>
                  <Link className="ch-row" to="/control/routes">
                    <span className="ch-row-name mono">{r.router.split('@')[0]}</span>
                    <span className="ch-row-val"><span className="ch-num">{fmtRps(r.rps)}</span> req/s</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {src.state === 'error' && <SourceNote state="error" what="a fresh reading" />}
        </>
      )}
    </Card>
  );
}
