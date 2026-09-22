// The one confirm step every cluster change goes through - in the deployment
// dialog, in a table row on the Cluster page, and in the ConfigMap editor.
//
// It follows the catalog's level exactly:
//
//   click       a second step that names the object and the consequence
//   type-name   the same, plus typing the name the SERVICE also checks
//               (lib/kube-actions.ts confirmNameOf) - so the level means the
//               same thing from curl
//
// The level is read per REQUEST, not per action (confirmLevelOf, CL-4): scale
// is one click at 1 to 3 and asks for the name at 0, so this form grows and
// loses its type-name field as the replica count changes under it.
//
// and then shows the outcome in words, or the refusal in words. It never
// retries: a retried PATCH is a second action.

import { Loader } from './ui/Loader';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  confirmLevelOf, confirmNameOf, confirmSatisfied, kubeCall, kubeRefusalOf,
  type KubeActionSpec, type KubeRefusal,
} from '../lib/kube-actions';
import { Dialog, type FocusTarget } from './ui/Dialog';
import './KubeActions.css';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

export interface Outcome { line: string; sub?: string }

type Phase =
  | { t: 'confirm' }
  | { t: 'working' }
  | { t: 'done'; out: Outcome }
  | { t: 'failed'; refusal: KubeRefusal };

export interface ConfirmPanelProps {
  spec: KubeActionSpec;
  /** The request without `confirm` - namespace, the target field, params. */
  req: Record<string, unknown>;
  /** What the object is called in sentences ("frontend", "LOG_LEVEL"). */
  what: string;
  consequence: ReactNode;
  /** Parameter inputs, drawn above the type-name field. */
  fields?: ReactNode;
  /** False while a parameter input is invalid. */
  valid?: boolean;
  /** The submit button's label. Defaults to the action title and `what`. */
  goLabel?: string;
  describe: (result: never) => Outcome;
  onBack: () => void;
  /** Called after a success, e.g. to re-read the table this came from. */
  onDone?: () => void;
}

export function ConfirmPanel({ spec, req, what, consequence, fields, valid = true, goLabel, describe, onBack, onDone }: ConfirmPanelProps) {
  const [phase, setPhase] = useState<Phase>({ t: 'confirm' });
  const [typed, setTyped] = useState('');
  const firing = useRef(false);
  const name = confirmNameOf(spec, req);
  const level = confirmLevelOf(spec, req);
  const ready = valid && confirmSatisfied(level, typed, name);
  // The panel REPLACES the list whose button opened it, so that button is gone
  // and focus has fallen to the dialog container. Put it on the first thing the
  // reader has to deal with - the first field, else the way out.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const f = form.current;
    if (!f || f.contains(document.activeElement)) return;
    (f.querySelector<HTMLElement>('input, select') ?? f.querySelector<HTMLElement>('button'))?.focus();
  }, []);

  const run = async () => {
    if (firing.current || !ready) return;
    firing.current = true;
    setPhase({ t: 'working' });
    try {
      const body = level === 'type-name' ? { ...req, confirm: typed } : req;
      const r = await kubeCall<never>(spec, body);
      setPhase({ t: 'done', out: describe(r) });
      onDone?.();
    } catch (e) {
      setPhase({ t: 'failed', refusal: kubeRefusalOf(e, spec, what) });
    } finally {
      firing.current = false;
      setTyped('');
    }
  };

  if (phase.t === 'working') {
    return <p className="sa-working"><Loader state="act" size="sm" label={`${spec.title}…`} /></p>;
  }
  if (phase.t === 'done' || phase.t === 'failed') {
    return (
      <div className="sa-outcome" data-ok={phase.t === 'done' ? 'true' : 'false'} role="status" aria-live="polite">
        <p className="sa-outcome-h">{phase.t === 'done' ? phase.out.line : phase.refusal.title}</p>
        {(phase.t === 'done' ? phase.out.sub : phase.refusal.detail) && (
          <p className="sa-note">{phase.t === 'done' ? phase.out.sub : phase.refusal.detail}</p>
        )}
        <div className="ka-row"><Button variant="ghost" onClick={onBack}>Back</Button></div>
      </div>
    );
  }
  return (
    <form className="ka-confirm" ref={form} onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <p className="sa-warn">
        <Icon icon={AlertTriangle} size="md" />
        <span>{consequence}</span>
      </p>
      {fields}
      {level === 'type-name' && (
        <label className="ka-field">
          <span className="ka-label">Type <span className="mono">{name || '…'}</span> to confirm</span>
          <input
            className="ka-input mono" autoComplete="off" spellCheck={false} value={typed}
            onChange={(e) => setTyped(e.target.value)} aria-invalid={typed.length > 0 && typed !== name}
            aria-describedby="ka-confirm-hint"
          />
          {/* CL-10: a red border was the WHOLE message, and the focus ring -
              which is over the field while you are typing in it - covered it.
              The mismatch is now said, and linked to the field so a screen
              reader gets it with the field rather than somewhere on the page. */}
          <span className="ka-hint" id="ka-confirm-hint">
            {typed.length > 0 && typed !== name
              ? <span className="ka-bad">That is not {name}. The service checks the same string.</span>
              : `The name of what this acts on: ${name || 'the target'}.`}
          </span>
        </label>
      )}
      <div className="ka-row">
        <Button variant="ghost" onClick={onBack}>Leave it alone</Button>
        {/* Deleting cannot be undone from here, so it reads as danger; every other
            cluster change is consequential but recoverable - caution. */}
        <Button variant={spec.id.startsWith('delete-') ? 'danger' : 'caution'} type="submit" disabled={!ready}>{goLabel ?? `${spec.title}: ${what}`}</Button>
      </div>
    </form>
  );
}

/** The same panel in its own dialog, for a control that lives in a table row. */
export function ConfirmDialog(props: Omit<ConfirmPanelProps, 'onBack'> & { onClose: () => void; title?: ReactNode; returnFocusTo?: FocusTarget }) {
  const { onClose, title, returnFocusTo, ...panel } = props;
  return (
    <Dialog
      open
      returnFocusTo={returnFocusTo}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={title ?? <span className="sa-title">{panel.spec.title} <span className="mono">{panel.what}</span></span>}
      description={panel.spec.meaning}
    >
      <div className="ka-body">
        <ConfirmPanel {...panel} onBack={onClose} />
      </div>
    </Dialog>
  );
}
