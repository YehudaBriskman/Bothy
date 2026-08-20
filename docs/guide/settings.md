# Settings, and what deliberately is not there

Settings is mostly a **read-only** page, and that is the design rather than a
stage it is passing through. It is worth understanding why, because "why can I
not change this here" is the question the page exists to answer.

## The word "settings" collapses three different things

| Thing | Belongs to | Where it lives |
|---|---|---|
| theme, pane widths, collapsed groups, reading size | the **browser** | this browser's local storage |
| identity, roles, where the session came from | the **user** | the session token, changed in the realm |
| a default root, a landing page, favourites | the **user** | nowhere yet - no store exists |

Almost every complaint about the page dissolves once those three are apart. A
pane width is a fact about the screen you are sitting at; carrying it to your
phone would be the bug, not the feature. Your roles are a fact about your
account; changing them here would mean this page could grant itself privileges.

## The three groups on the page

**You.** Who the session says you are, which roles you hold, what each one
permits, and where the session came from. All of it arrives with the token.

The one rule to carry out of the roles panel: **it is a description of a token,
not a permission check**. A role missing from that list has never stopped a
request. It explains, in advance, the 403 that would have come back. What the
interface hides is never what the API enforces - see [Roles](roles.md).

**Appearance.** The theme picker, the two ways to make a theme, and the reading
size. These write to this browser and nowhere else.

**Where these are kept.** One row per store, each answering the question a
reader actually arrives with: *does this follow me to another device?* The
answers differ, which is the whole reason the stores are worth telling apart.

## Reading size

Two numbers, under Appearance:

- **Document text** - the rendered page in Files: prose, tables and code.
- **Panel text** - the document index on the left and the outline on the right.

They are separate because they answer different questions. Raising the document
reflows prose and does nothing to the rails; raising the panels makes the index
legible without touching a word of prose. One control would tie them together
and neither would land where you wanted it.

Each shows a sample at the size it is set to, because "12.5px" is a number
nobody thinks in. Both are stored per browser, and the Stores table says so.

## Why there is no "coming soon" form

The page does not render a greyed-out control labelled *not yet*. A control that
cannot work is a promise the page has no way to keep, and a sentence saying why
is both shorter and true.

The reason those preferences have nowhere to live is not that nobody has got
round to it. **A store is a write path, and a write path is a threat model, an
audit trail and a boundary.** It is worth paying for when there is a preference
somebody actually wants kept - and the page exists partly to make that moment
obvious when it arrives.

Four features are waiting on that one decision: group naming and ordering,
favourites, a default root, and a default landing page. The argument is written
up in [`docs/plans/control-and-settings.md`](../plans/control-and-settings.md)
§6b, and it is genuinely open rather than rhetorical.

## What a form here would be allowed to change

If a settings form is ever built for the **system** rather than the browser, two
constraints are already fixed and are worth knowing before you propose one:

- **Never render environment values.** `.env` holds real secrets, which is why
  the file service refuses it by name. A compiler over it may show **keys and
  whether they are set** - `POSTGRES_PASSWORD  set`, `ALERT_EMAIL_TO  not set` -
  and never the value. A settings page that printed `.env` to any tailnet viewer
  would undo a control that already exists.
- **Do not parse compose to build it.** The declaration layer already exists and
  is already reconciled against host truth ([Declaring a project](projects.md)),
  and a compose file is not a form - it is a program, with `privileged`,
  arbitrary mounts and arbitrary commands. A UI that round-trips compose is a UI
  that can write arbitrary code onto the box.

## What is not stored anywhere

- **Which documents you have read** is kept in this browser, newest first, and
  nowhere else.
- **Your favourites** do not exist, per the above.
- **Nothing on this page is written to the box** except a theme you author,
  which is a real `.css` file and is shared by every browser that reaches it -
  the choice of theme is per browser, the theme itself is not.

## Related

- [Roles](roles.md) - what each role permits, and where that is actually enforced
- [Themes](themes.md) - the picker, and writing your own
- [Operating it from the console](the-console.md) - the rest of the interface
- [`docs/plans/control-and-settings.md`](../plans/control-and-settings.md) - the argument, in full
