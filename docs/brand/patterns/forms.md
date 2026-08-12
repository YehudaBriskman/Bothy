# Forms and validation

_Status as of 2026-08-10._

## The rule

**Every input has a visible, programmatically associated label.** A placeholder
is not a label: it disappears on focus, fails contrast, and is not announced as
a name.

**Placeholder text is an example, never an instruction.**

**Mark required in text as well as in ARIA.** An asterisk in a colour is
colour-alone.

**Set type, input mode and autocomplete.** These are free, and they are the
difference between a usable and an infuriating mobile form.

**Validate on blur, then on change once a field has errored.** Validating on the
first keystroke tells someone their half-typed email is invalid, which is both
true and useless.

**Error text sits beside its field**, is linked with `aria-describedby`, and a
submit-time failure raises a live region. Forms longer than three fields also
get a summary that links to each failing field.

**Error text says what happened and what to do.** Never just "invalid", never
blame the user.

**Pick one submit policy** - disabled-until-valid, or always-enabled with an
explanation - and never mix them in one product. Disabled-until-valid hides
*why*, which is why the second is usually better.

**Prevent double submission** and show a loading state.

**Destructive actions need typed confirmation or an undo window.**

**Secrets use a password input** with a reveal toggle, and never appear in a URL
or a log.

**Enter submits, Escape cancels, tab order matches visual order.**

**Targets meet 24x24 minimum; frequent ones 44x44.**

## Checklist

See [CHECKLIST.md § 14](../CHECKLIST.md#14-forms-and-validation).

## What Bothy decided, and why

**There is essentially no form system, and that is the honest status.** The
product is read-only: it has search inputs, a couple of selects and a log filter,
and no form that creates or changes anything. Nothing above has been exercised.

What the existing inputs do follow:

- Search inputs submit on Enter and blur on Escape.
- The log search applies on submit rather than per keystroke, because each query
  is a real request.
- Every input's focus ring was fixed on 2026-08-10 - several had removed it and
  replaced it with a border tint. See
  [component-states](component-states.md).

**If this product ever grows a real form, the contract above is written before
the form is**, not after. That is the point of keeping this document even though
it is currently mostly aspirational - it is a decision waiting to be applied,
not a description.

## Dead ends

None. Nothing here has been got wrong yet, because nothing here has been built.

## How this is verified

- Assert every input has an associated label.
- Assert error text is linked to its field.
- Check targets meet the minimum size.
