// Button - THE button look in this app (design audit SYS-7, 2026-09-21).
//
// Before this there was one global `.btn` with no :disabled rule, six scoped
// copies of a disabled state, five different `.btn.sm`s, a `.te-danger` in one
// page, and a `.set-danger` that no stylesheet defined at all - so the two
// destructive confirms ("Delete this pod", "Yes, clear all N") rendered exactly
// like the Cancel beside them. Now:
//
//   primary    the accent fill - the one thing on a surface you are invited to do
//   secondary  a raised neutral fill (the default)
//   ghost      no fill, a hairline - the way out, the quiet alternatives
//   danger     UNFILLED, in --st-down-fg, tinted --st-down-bg on hover. Distinct
//              from Cancel without becoming the loudest thing in the dialog
//              (owner decision 9, 2026-09-21).
//   caution    a neutral label with an amber edge: a consequential action that
//              is not destructive (restart, scale, apply an update)
//
// and `size="sm"`, a real disabled state (opacity token, no hover, no press),
// tokenised transitions, the shared press state and the --hit floor.
//
// checks/design-tokens.mjs refuses a hand-written `btn` class anywhere else in
// src/, so a new button comes through here. A link or a <span> that has to LOOK
// like a button (a sign-in <a>, a router <Link>, the accent preview) takes
// `buttonClass()` - the same classes, from the one place that writes them.

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'caution';
export type ButtonSize = 'md' | 'sm';

export interface ButtonLook {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A square button holding only an icon. Give it an aria-label. */
  iconOnly?: boolean;
}

/** The class list for the look, for an element that is not a <button>. */
export function buttonClass({ variant = 'secondary', size = 'md', iconOnly = false }: ButtonLook = {}, extra?: string): string {
  return ['btn', `btn-${variant}`, size === 'sm' && 'btn-sm', iconOnly && 'btn-icon', extra]
    .filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonLook {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, iconOnly, className, type = 'button', ...rest }, ref,
) {
  return <button ref={ref} type={type} className={buttonClass({ variant, size, iconOnly }, className)} {...rest} />;
});
