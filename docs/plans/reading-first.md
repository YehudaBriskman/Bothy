# Reading first: what Files opens as

_Written 2026-08-17. Status: proposed._

Bothy Files is an IDE. Four regions, tabs, splits, a bottom panel, an activity
bar. That is the right shape for changing code and the wrong shape for the thing
people actually do here most: **read a document.**

The proposal: **the page opens as a reader.** A rendered document, a side panel
of documents beside it, and nothing else. The full editor stays, one deliberate
click away, at its own route.

---

## 1. The evidence

| | |
|---|---|
| markdown under `docs/` + `~/claude-notes` | **76 files, 9,141 lines** |
| what replaced the MkDocs site | this page |
| what the page shows on arrival | an empty centre, six keyboard shortcuts, "Pick a file on the left to begin" |

The renderer is not the problem. `.fx-read > * { max-width: 72ch }` already
exists, so a rendered document already has a reading measure. What surrounds it
is an editor: a tab strip with one tab, an inspector of file facts, a problems
panel, a gutter, line numbers, and a tree of 3,500 files to find 76 documents in.

The tax is paid on every read, by everyone, forever - to make the rarer case
(changing a file) one click cheaper.

---

## 2. Two modes, one page, one nav slot

```
/files                      READ   the default. A document, and how to find one.
/files/edit                 WORK   the IDE exactly as it is today.
```

Both accept the existing `?root=&path=`, so every deep link that exists keeps
working and either mode can be linked into. **One nav entry** - the top nav does
not grow back.

Getting between them is not a mode switch in a settings sense; it is a
destination:

- **Read → Work**: an `Edit` control on the open document. Role-gated on
  `editor`, and absent rather than disabled for someone who cannot write - the
  reader should not carry a control that exists to be refused.
- **Work → Read**: the editor's own breadcrumb, so closing the tools is one
  click and does not lose the file.

---

## 3. The reading view, concretely

Three parts. Nothing else on the page.

### The document

`FileView` from [`files-decomposition.md`](files-decomposition.md) - the same
renderers, no workspace. 72ch measure, which already exists. What it drops:
tabs, splits, the inspector, the bottom panel, the gutter, line numbers, the
activity bar.

What it keeps, because a reader needs them and an IDE buried them:

- **In-page headings**, right, as a table of contents that tracks the scroll.
  This is the thing a docs viewer has and a file explorer does not, and it costs
  no new data: `md.tsx` already parses every heading to render it.
- **One provenance line** under the title - last changed, by whom, how long ago.
  The editor shows this as an inspector panel of eleven facts; a reader needs one
  sentence and a link to the history.

### The side panel - a document index, not a filesystem

This is the part that must not be the Explorer with different CSS.

- **Grouped by root, then by folder**, but showing **titles** rather than
  filenames: `network/dns.md` reads as "DNS", `runbook-cant-reach.md` as
  "Can't reach the box".
- **Prose first.** Markdown, rst, txt. Everything else - 117 code files and 42
  configs in the stacks root alone - lives behind one **"All files"** toggle that
  reveals the full tree. The reader is not lied to about what exists; it is
  ordered by what it is for.
- **Search at the top**, not behind an icon. Search is the feature that made the
  docs site deletable and it is the second most common way to arrive.

**Where titles come from, without building an index.** A prettified filename is
free and correct most of the time. Better is the document's own first heading,
and the cheap way to get it is a `titles=1` parameter on `/tree` that reads the
first 200 bytes of `.md` files *only* - 84 files across the two doc roots, not a
walk of 3,500. Do the filename version first; add the parameter only if the
titles are actually wrong often enough to notice.

### Cross-document links must resolve

Today `md.tsx` renders a repo-relative link as inert text, deliberately, because
it cannot resolve one and `javascript:` must never become an `href`. In an IDE
that is a papercut. **In a reader it is a broken product** - `~/claude-notes` is
built on wikilinks, and a documentation site whose links do not click is not a
documentation site.

This is the one item on the list that is a blocker rather than an improvement.
The fix is scoped in [`first-party-stack.md`](first-party-stack.md) §1.3: join
the target against the current file's directory, normalise, and hand it to the
same open-file action - never an `<a href>`, so the `javascript:` argument that
file records stays true.

---

## 4. What it is called

**Still `Files`.** The nav label does not change, because the contents have not:
this reads files, and some of them are compose files and Python. Calling it Docs
would be narrower than the truth and would re-use the name of a service that was
deleted for being a mirror of these same files.

The two modes are not named in the interface at all. The page is the reader;
`Edit` is a button on a document. A user who never presses it never learns there
were two modes, which is the correct amount to learn.

---

## 5. What this is not

- **Not a second renderer.** Both modes use the same `FileContent`. If the
  reading view ever needs its own markdown path, the split is wrong.
- **Not a rewrite of the editor.** `/files/edit` is today's page, unchanged, at a
  route. The work is a new default, not a replacement.
- **Not a docs-only viewer.** It renders whatever `FileContent` renders - JSON,
  images, PDFs, code with highlighting. Prose is ordered first in the index; it
  is not the only thing readable.
- **Not an editor with the controls hidden.** Reading mode does not fetch a
  draft, hold a dirty state, or know about conflicts. If it did, it would be the
  IDE with a smaller stylesheet, and every future change would have to be made
  twice or made carefully.

---

## 6. Sequence

Each step is shippable and leaves the product coherent.

1. **`FileContent`** extracted from `DocBody` - pure, no behaviour change, the
   existing page its first consumer. (Step 1 of `files-decomposition.md`.)
2. **`FileView`** - `FileContent` plus one fetch and its empty/denied states.
3. **Relative links resolve.** The blocker. Do it before the reader ships, not
   after, or the reader ships broken.
4. **The reading page** at `/files`, with the document index and the in-page
   headings. The IDE moves to `/files/edit`; every existing deep link is tested.
5. **`Edit` on a document**, role-gated, landing on the same file in the editor.
6. Titles from the first heading, *only if* prettified filenames prove
   insufficient in use.

---

## 7. The risk worth naming

The failure mode is that the reader becomes a worse editor rather than a better
reader - a page that renders a document and then grows a save button, then a
dirty indicator, then a conflict dialog, until there are two editors to maintain
and the second one is missing the conflict check that makes the first one safe.

The line that prevents it: **reading mode never writes.** Not "does not write
yet". If a change would give it a write path, it belongs in `/files/edit`, and
the reader's answer is the `Edit` button it already has.
