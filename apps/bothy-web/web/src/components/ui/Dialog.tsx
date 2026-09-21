// Dialog - Radix primitive, portal tokens. THE ONLY MODAL IN THE APP.
//
// This is the shadcn arrangement: Radix owns the behaviour (focus trap, Escape,
// scroll lock, `aria-modal` + labelling, inert background, portalling out of
// any `overflow: hidden` ancestor), and the styling is ours. Only the styling
// layer differs from upstream shadcn - they write Tailwind classes, we write one
// CSS file against the same tokens, because this app has no Tailwind and adding
// it to get a dialog would be a tail-wags-dog migration.
//
// Two shapes, one behaviour:
//   Dialog         the framed dialog - title, description, body, footer.
//   DialogSurface  the same behaviour with no frame, for a surface that draws
//                  its own (the command palette, the Settings sections drawer).
// checks/a11y-contract.mjs fails the build's checks if anything else in src/
// imports @radix-ui/react-dialog or hand-rolls `aria-modal`, so a new modal has
// to come through here and gets all of the below for free.
//
// FOCUS RETURN IS OURS, NOT RADIX'S (2026-09-21, design audit SYS-4). Radix
// returns focus to its own <Dialog.Trigger>, and this app never uses one: every
// dialog is opened by a row button, a menu item or a matrix cell that sets
// state. So Radix's close path focused `triggerRef.current` - null - and focus
// fell to <body> on every close. A keyboard user closing the service dialog
// landed at the top of the document, 40 rows away from where they were; the
// nested kube confirm sent focus OUT of the modal that was still open.
//
// What happens instead, on close AND on unmount (Radix calls onCloseAutoFocus
// from its FocusScope teardown in both cases, which is why the consumers'
// `{open && <Dialog/>}` pattern works too):
//   1. whatever had focus when the dialog opened, if it is still there -
//      captured in a layout effect, which runs before Radix's own passive
//      effect moves focus into the dialog;
//   2. else `returnFocusTo`, when the caller named a fallback for an opener
//      that may not survive (a Save button the edit it saved removes, a row
//      the dialog's own action deletes);
//   3. else, when a dialog is still open underneath (a nested confirm whose
//      trigger was a row that has since gone), into THAT dialog - never behind it.

import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject,
} from 'react';
import './Dialog.css';

/** Where focus goes when the dialog closes. A getter is read AT CLOSE, so it can
 *  find an element that did not exist when the dialog opened. */
export type FocusTarget = RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined);

const resolve = (t?: FocusTarget): HTMLElement | null =>
  !t ? null : typeof t === 'function' ? t() ?? null : t.current;

/** Still somewhere a keyboard user could be put: attached, rendered, not inert,
 *  not a disabled control, and not the document itself. */
function landable(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && el !== document.body
    && !el.closest('[inert],[hidden]')
    && !(el as HTMLButtonElement).disabled
    && el.getClientRects().length > 0;
}

const TABBABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The innermost dialog that is still open, and the first control in it. */
function openDialogBeneath(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')];
  const top = open.at(-1);
  if (!top) return null;
  return [...top.querySelectorAll<HTMLElement>(TABBABLE)].find(landable) ?? top;
}

/** The focus-return half of the contract above, as a hook, so both shapes share it. */
function useFocusReturn(open: boolean, returnFocusTo?: FocusTarget) {
  const opener = useRef<HTMLElement | null>(null);
  const target = useRef(returnFocusTo);
  target.current = returnFocusTo;
  useLayoutEffect(() => {
    if (!open) return;
    const a = document.activeElement;
    opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
  }, [open]);
  return useCallback((e: Event) => {
    e.preventDefault(); // Radix's own fallback is its (absent) trigger, then <body>
    const next = [opener.current, resolve(target.current)].find(landable) ?? openDialogBeneath();
    next?.focus({ preventScroll: false });
  }, []);
}

interface Shared {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** See the header: where focus goes if the element that opened the dialog is
   *  gone by the time it closes. Not needed when the opener survives. */
  returnFocusTo?: FocusTarget;
}

export interface DialogProps extends Shared {
  title: ReactNode;
  /** Rendered under the title. Also the dialog's accessible description. */
  description?: ReactNode;
  /** Right-aligned in the header - a status chip, a count, an open-in-new link. */
  headerAside?: ReactNode;
  footer?: ReactNode;
  /** Wider variant for tables and log output. */
  size?: 'md' | 'lg';
  children: ReactNode;
}

export function Dialog({
  open, onOpenChange, returnFocusTo, title, description, headerAside, footer, size = 'md', children,
}: DialogProps) {
  const onCloseAutoFocus = useFocusReturn(open, returnFocusTo);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="dlg-overlay" />
        <RD.Content className={`dlg dlg-${size}`} onCloseAutoFocus={onCloseAutoFocus}>
          <header className="dlg-head">
            <div className="dlg-head-text">
              <RD.Title className="dlg-title">{title}</RD.Title>
              {description ? (
                <RD.Description className="dlg-desc">{description}</RD.Description>
              ) : (
                // Radix warns when a dialog has no description; this says
                // "deliberately none" rather than leaving a console warning that
                // trains everyone to ignore console warnings.
                <RD.Description className="sr-only">Details</RD.Description>
              )}
            </div>
            {headerAside && <div className="dlg-head-aside">{headerAside}</div>}
            <RD.Close className="dlg-x" aria-label="Close">
              <X size={16} />
            </RD.Close>
          </header>

          {/* scroll-shade: long bodies get the same top/bottom inner shadows as
              every other scroller in the app, so a clipped dialog looks clipped. */}
          <div className="dlg-body scroll-shade">{children}</div>

          {footer && <footer className="dlg-foot">{footer}</footer>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export interface DialogSurfaceProps extends Shared {
  /** The accessible name. Rendered visually hidden unless `titleVisible`, in
   *  which case the surface draws its own <DialogTitle> and this is ignored. */
  title: ReactNode;
  titleVisible?: boolean;
  overlayClassName: string;
  className: string;
  children: ReactNode;
}

/** The same modal behaviour for a surface that draws its own frame. */
export function DialogSurface({
  open, onOpenChange, returnFocusTo, title, titleVisible = false, overlayClassName, className, children,
}: DialogSurfaceProps) {
  const onCloseAutoFocus = useFocusReturn(open, returnFocusTo);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className={overlayClassName} />
        {/* No description: the surfaces that use this are a search box and a
            list of links, and a description would only restate the title. */}
        <RD.Content className={className} aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
          {!titleVisible && <RD.Title className="sr-only">{title}</RD.Title>}
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

// DialogClose and DialogTitle stay and DialogTrigger went, which looks arbitrary
// and is not. Both shapes are CONTROLLED-ONLY - they require `open`/`onOpenChange`
// and own RD.Root internally - so a Trigger placed in `children` would render
// INSIDE the already-open dialog. It could not work, which makes it a misleading
// re-export rather than an escape hatch. Close and Title render inside Root and do.
export const DialogClose = RD.Close;
export const DialogTitle = RD.Title;
