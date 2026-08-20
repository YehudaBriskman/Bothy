# The guide, and the reader around it

_Written 2026-08-20. Status: proposed, nothing started._

`docs/plans/reading-first.md` argued that Files should open as a reader, and it
shipped (#94, #103, #129, #138). This document is the next argument, and it comes
from using the thing: the reader is right about the document and wrong about
almost everything around it.

Ten complaints, and they are not ten separate bugs. They are three:

1. **The reader does not know what it is for.** It opens on whichever root
   happens to be writable first - one person's private notes - and offers the
   guide as one card among seven. The manual for the product is not the
   destination; it is a link.
2. **The side panel is still the Explorer's controls in the reader's clothes.**
   A four-root scope select, a glob box and a case toggle, crammed into 296px,
   answering questions a reader browsing a manual does not have.
3. **The document has no single width, and one panel is not inside the
   document at all.**

---

## 1. Files opens on the guide. Not "usually" - always.

`/files` today lands on Start with `?root=` set by `defaultRoot()`, which picks
the first writable root. On this box that is `notes`. #94 already fixed this once
- it used to redirect straight into that root's README, and the complaint was
that "open Files" meant "open somebody else's filing system". Start replaced the
redirect, which stopped the ambush but left the destination unanswered: the first
screen is still a chooser, and the thing a new reader needs is one click past it.

**The proposal: `/files` is the guide.**

```
/files              →  redirect to /files/guide
/files/guide        GUIDE   the manual. The default, and what the nav points at.
/files?root=&path=  BROWSE  today's reader, unchanged. Every deep link survives.
/files/edit         WORK    the IDE, unchanged.
```

`routes.ts` is where this goes, because that module already owns every Files URL
and already has a truth table over it (`checks/redirect-table.mjs`). Two rules it
imposes on this change: `/files/guide` must be tested **before** `/files` in
`filesMode()` for the same reason `/files/edit` is (one is a prefix of the
other), and the builder must keep `?root=&path=` working on the browse mode or
the redirect table will say so.

**Guide mode is a mode, not a second page.** Same `Reader`, same `FileView`, same
`md.tsx`, same `Toc`. What changes is what the side panel is pointed at:
`root=stacks`, scoped to `docs/guide`, and no control that offers to leave.

**The way out is one control**, in the panel header, reading something like
"Browse all files". Guide mode has no root picker (item 3), because a manual with
a root picker on it is a filesystem browser that happens to be showing a manual.

---

## 2. The index is a tree of the guide, and nothing else

`DocIndex` is flat inside a root by design, and the design document says why:
"prose is ~84 files across the two documentation roots, and a tree exists to make
3,500 files navigable". That reasoning was right for a panel listing four roots.
It is wrong for a panel listing one folder of one root, where the folder
structure *is* the table of contents.

In guide mode the index is:

- **One root section, and it is not drawn as one.** No `stacks` header, no
  chevron, no lock glyph, no count - there is nothing to choose between.
- **A real tree**, nested, with expand and collapse. `tree.ts`'s `buildTree`
  already produces exactly this shape and the Explorer already renders it; the
  reader should reuse it rather than grow a second one.
- **Guide files only.** `isProse` is the wrong filter here - the scope is.
  The listing is fetched with `?path=docs/guide`, so the service walks the
  folder and nothing else can appear.
- **Ordered by the guide's own reading order**, not alphabetically. Today
  `configuring` sorts before `installing`, which is backwards for a manual whose
  pages end in `## Next`. The order lives in one place; see §7.

In browse mode the index keeps every root, and gains the same tree - the flat
"folder, then its files" grouping is the thing item 4 is complaining about.

---

## 3. The side panel's controls fit the panel they are in

`SearchView` is reused whole by the reader, which was the right call and is now
the source of three of these complaints. Its options row - a `select` capped at
110px, a mono glob input, and a 24px case toggle - is an IDE control strip at
296px, and it wraps, crowds and touches the edge.

**Guide mode gets two controls, side by side:** the search box, and the case
toggle. Nothing else. Search runs with `root=stacks` and `path=docs/guide`,
which `searchFiles()` already supports (`opts.path`) and `app.py` already
implements - no service change. No "every root", no glob: within seven documents
neither has a question to answer.

**Browse mode keeps all four**, but they stop competing for one row:

- search on its own row, full width;
- scope (root + folder) becomes the header control described in §4, not a
  `select` in the options row;
- glob and case share the second row, with the glob box given the width the
  scope select was taking.

The panel also needs its edges back. `padding: 0 10px` on a row whose text is
ellipsised means the last legible character is four pixels from a border. The
rail's own gutter should be one value, applied to every row in it.

---

## 4. Choosing where you are looking is a control, not links at the edge

Two defects, one cause.

**The scope does not survive opening a file.** `Reader.openDoc()` builds a fresh
`URLSearchParams` with `root` and `path` and nothing else, so `?in=` - the folder
you narrowed to - is dropped the moment you click a document. That is item 5's
"works only until I'm choosing a file and then it comes back". It is a two-line
fix and it is a bug, not a design question: `onScope` deliberately preserves
`path` for exactly the symmetric reason ("narrowing the index is a change to what
you are BROWSING, not to what you are reading").

**Choosing a root is a list of chips at the bottom of a scrolling panel.** In
browse mode the roots are `RootSection` headers interleaved with their contents,
so "go to `projects`" means scrolling past `notes`.

The replacement is one control in the panel header - a chip reading
`stacks / docs/guide` - opening a popover with:

- the roots, as the `fx-rootchip` group the Explorer already renders;
- a path input, monospace, with completions drawn from the listing the panel
  already holds (no new request, no new endpoint);
- Enter to go, Escape to close.

`fx-rootchip` and `fx-hbtn` both exist in `shell.css` and `explorer.css` and are
already the app's answer to these two shapes. This is assembly, not new chrome.

---

## 5. Two things in the document that are simply wrong

**The backlinks panel is not inside the document.** `Reader` renders
`<Backlinks>` as a *sibling* of `<FileView>` inside `.rd-body`, which is a flex
column; `FileView`'s root is `.fx-doc { flex: 1 }` and the scrolling element is
`.fx-read` inside it. So the panel is laid out **below the scroll container** -
permanently docked to the bottom of the pane, in view at every scroll position,
stealing height from the document on every page whether or not you care about
inbound links. The comment above it says "AFTER the document, never beside it",
which is the correct intent and the opposite of what the layout does.

The fix is to render it **inside** the scroller, as the last block of the
document, where its existing `max-width: var(--read-measure)` and its top rule
already make it read as a footnote. `FileView` taking a `footer` node is the
smaller change than making `.rd-body` the scroller, and it keeps `Toc`'s
`scrollerOf()` walk finding the same element.

**The Edit control is the only worded button in a strip of glyphs.** The reader
draws `<Link className="btn sm"><Pencil/> Edit</Link>`. Every other action bar in
Files - the editor's toolbar, the explorer's header - uses `.fx-hbtn`, a glyph, a
`<Tooltip>` and an `aria-label`, and `Editor.tsx` writes the rule out: "chrome
that spells itself out in words is chrome that keeps taking width from the file".
The reader's Edit should be that, with the same `Pencil` at the same size.

---

## 6. One width for a document

Today `.fx-read > *` is capped at `--read-measure` (72ch), and three kinds of
block are let out of it to `max-width: 100%`: tables, code fences, and paragraphs
containing an image. On a 1440px screen that is a document whose prose is ~660px
and whose tables are ~1100px - which is item 9, and it is not a nit. A block that
is 1.7× the width of the paragraph above it reads as a different document.

**The two escapes were each individually right.** #103's argument for figures
stands (a diagram capped at 72ch renders its 15px labels at 10px). The mistake is
that the escape hatch is `100%` - an unbounded value that means "however wide the
window happens to be" - rather than a second, bounded width.

So: **two tokens, both bounded, and the column itself capped.**

```
--read-measure: 72ch     prose. Unchanged - it is the one number here that
                         was already right.
--read-wide:    96ch     tables, code fences, figures, and the callout and
                         backlink blocks that sit at document level.
```

`.fx-read` gets `max-width: var(--read-wide)` so nothing in it can exceed the
column, and the three escapes target `--read-wide` instead of `100%`. Left edges
stay aligned; the widest block on the page is a known quantity; and a theme that
wants a different reading rhythm sets two values rather than fighting a `100%`.

Both are `ch`, so both track `--read-fs` - which is what makes §7 work.

---

## 7. Reading size, and where a preference lives

The right-hand outline is 11.5px and the index rows are 12.5px, on a surface
whose whole argument is that a document is not a dashboard. They should be
bigger, and more usefully they should be **settable**, because "bigger" is a
different number for a 14" laptop and a 27" monitor.

Two tokens, applied on the reader's root element:

```
--read-fs         the document. Already exists (16px).
--rd-ui-fs        the panels - index rows, outline entries, breadcrumbs.
                  New; these are ~30 literal values today, which is the same
                  problem --read-* was tokenised to fix in the first place.
```

**Where the value is stored is a real decision and #145 is already open on it.**
`docs/plans/control-and-settings.md` §6b draws the line: theme, pane widths and
collapsed groups belong to the **browser** and `localStorage` is honest about
that; identity and roles belong to the **user**; and only "default root, default
landing page, favourites" needs a store that does not exist.

A text size is on the browser's side of that line by the same test - it is a fact
about the screen you are sitting at, not about you - so it can ship now, as
`bothy-reading-v1`, beside `bothy-files-panes-v1` and `bothy-read-recent-v1`, and
Settings can document it in the table that already documents those three.

A VS-Code-style per-user `settings.json` is a larger thing and it is #145's
question, not this document's. If the answer there turns out to be yes, this
preference moves into it and the localStorage key becomes the fallback - which is
the same migration the theme would make.

---

## 8. The guide is seven pages and the product is bigger than seven pages

`docs/guide/` covers installing, configuring, the console, files, roles and
themes. Everything below is either documented only in a design document, only in
`ARCHITECTURE.md`, or only in the source:

| New page | What it has to say | Source that already exists |
|---|---|---|
| `the-cli.md` | every `bothy` subcommand, what passes through to `just`, `init`/`upgrade`/`self-update` | `scripts/bothy` `usage()`, `scripts/checks/cli-commands.sh` |
| `projects.md` | declaring a project so the console can see it - **`project.dev.yml`, which is YAML and not TOML** - every key, every service key, every state | `apps/portal-collector/README.md`, `collect.py:664`, `edge/dynamic/project.example.yml` |
| `services.md` | adding a service to the stack, the `dev.portal.*` labels, grouping, what publishes a port | `ARCHITECTURE.md` §7, §5, `CONTRIBUTING.md` |
| `settings.md` | what Settings shows, what it deliberately will not write, and why | `control-and-settings.md` §6, `Settings.tsx` |
| `monitoring.md` | what is scraped, what is retained, where the dashboards come from | `ARCHITECTURE.md` §5, `monitoring/` |
| `backups.md` | the timer, retention, what is and is not covered, restoring | `README.md` §Backups, `scripts/backup.sh` |
| `troubleshooting.md` | the traps, generalised - a 200 proves nothing, no `Host()` rules, dotless hostnames | `README.md` §"Things that will catch you", `ARCHITECTURE.md` §8 |
| `upgrading.md` | what `bothy upgrade` does to the box vs `self-update` to the tool | `scripts/bothy`, #141 |

`themes.md` also needs the file-format half it currently defers to
`apps/portal-next/data/themes/README.md`, since the guide is written for
"somebody who has not read the source".

Three constraints, all of them existing:

- **No front-matter.** Nothing in this repository has any. One H1 on line 1.
- **Every relative link must resolve** - `scripts/checks/doc-links.sh` fails CI
  otherwise.
- **Adding a page means editing three other things**: the "Where to start" table
  in `docs/guide/index.md`, the table in `README.md` (including its hard-coded
  "Seven pages", which is exactly the rotting sentence `start.ts` warns about),
  and the `## Next` footer of its neighbours.

That third constraint is the argument for §2's ordering living in one place: an
ordered manifest the guide index, the README table and the reader's tree can all
read, instead of three hand-maintained lists that already disagree.

---

## 9. Sequence

Each step ships on its own and leaves the product coherent.

1. **The two document-level bugs** (§5) - backlinks inside the scroller, Edit as
   a glyph. Smallest, visible immediately, no new concepts.
2. **One width** (§6) - two tokens, four rules.
3. **The tree** (§2, browse mode) - reuse `buildTree`, nested and collapsible.
4. **Guide mode** (§1, §3) - the route, the redirect, the scoped listing, the
   two-control panel. Depends on 3.
5. **The scope control** (§4) - the header chip and its popover, and the
   `openDoc` fix, which can land with any of the above.
6. **Reading size** (§7) - the tokens, the store, the Settings row.
7. **The pages** (§8) - and the ordering manifest, which step 4 will want.

## 10. What this is not

- **Not a second reader.** Guide mode is a scope and a panel, not a page. If it
  ever needs its own renderer or its own document component, the split is wrong.
- **Not a write path.** `reading-first.md` §7 stands unchanged: reading mode
  never writes. Every preference here is `localStorage`.
- **Not a docs site.** The guide is still files in a root, served by the same
  four endpoints, editable by the same editor, with no index to keep in sync
  beyond the one ordering manifest §8 asks for.
