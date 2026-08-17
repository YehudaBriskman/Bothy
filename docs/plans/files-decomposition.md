# What Bothy Files is, once its parts are used elsewhere

_Written 2026-08-17. Status: proposed._

The observation: there are three capabilities inside Bothy Files, and every one
of them is wanted somewhere else.

1. **Render** — markdown, code, JSON, images, PDFs, shown well.
2. **Edit** — change the bytes, safely.
3. **Browse and control** — the tree, roots, search, git state.

Wanted by: a service's config file, docs viewing, docs editing, and whatever
comes next. So: what stays on the Files page, and is "Files" still its name?

---

## 1. The split point is not where it looks

Measured, rather than guessed:

| capability | lines | coupling |
|---|---|---|
| render | 827 (`md.tsx`, `highlight.tsx`, `JsonView.tsx`, `CodeSurface.tsx`) | **almost none** |
| edit | 1,174 (`Editor.tsx`) | the workspace model |
| browse | 1,395 (`Explorer`, `tree`, `Search`, `SourceControl`, `gitdeco`) | the file API |

`md.tsx` imports exactly two things: a language helper and the highlighter. It
holds no state, makes no request, and knows nothing about tabs, roots or the
workspace. **The renderers are already portable.** Nothing has to be untangled to
reuse them.

What is fused is the **dispatch** — the decision "which renderer does this file
get?" It lives in `DocBody` (`Editor.tsx`), as a run of branches on `kind` and
`view`: image, pdf, media, framed, binary, markdown-preview, json-preview, else
the text surface. That function is the only reason rendering feels welded to the
editor, and it is perhaps forty lines.

**So the first extraction is one component, not a refactor of three subsystems:**

```
<FileContent bytes lang kind view />     pure; no I/O, no role, no workspace
```

Everything that wants to *show* a file — a service's config, a doc, a diff
preview, a future terminal's output pane — takes that and nothing else.

Then, in order of how much they carry:

```
<FileView root path />        FileContent + one fetch + the not-found/denied states
<FileEditor root path />      FileView + draft, dirty, conflict, save. Needs `editor`.
```

`FileEditor` is where the workspace model stays behind a boundary: tabs, split
groups and undo-across-tab-switch are properties of a *page* where you work on
many files, not of an editor embedded in a service page where there is one.

---

## 2. What is left on the Files page

Once render and edit are embeddable, the page's unique job is the one thing no
embedded use can do: **work across files.**

- search the contents of every root at once;
- navigate a tree you did not already know the shape of;
- see what has changed across a repo, and diff it.

That is a real job and it is worth a top-level nav slot. It is also, notably, the
job the page is *worst* at advertising today.

---

## 3. The actual problem is the default view, not the name

**Keep the name.** "Files" is plain, accurate, and already the nav label under
the two-register rule. Renaming it to Workspace or Editor would describe the
tool rather than the contents, and the contents are the point — this is the
surface that replaced the docs site.

The defensible complaint is what the page *does when you arrive*. Right now the
centre is empty, with a list of keyboard shortcuts and "Pick a file on the left
to begin." For the surface that replaced a documentation site, the front page is
a blank sheet and a request that you already know what you want.

The page knows better than that. It already computes, and shows in its own
header, "N uncommitted changes". It has search across every root. It has git
history per file.

**Proposal: open on what changed.** A default pane offering, in order:

1. **Changed files** — from the git status it already has. On a box where the
   answer to "what was I doing" is nearly always "the thing I last edited", this
   is the highest-value list available and it costs no new data.
2. **Roots**, with a file count each — the four entry points, so a newcomer can
   see the shape without expanding a tree.
3. **Search** — one field, focused, because the second most common arrival is
   "where is the thing that says X", and search is now the feature that made the
   docs site deletable.

None of that is a new subsystem. All three facts are already on the page.

---

## 4. Where each capability gets used

| Surface | Uses | Not |
|---|---|---|
| A service's page | `FileView` on its compose file, read-only, collapsed | not an editor - "Edit in Files" is a link |
| Settings / config | **neither** - a typed form over a declared field | not a file editor with a skin |
| Docs viewing | `FileView` | |
| Docs editing | the Files page | |
| Diff, history | `FileContent` | |

The second row is the one worth stating twice, because it is the one that will
be got wrong: **a config form is not an embedded editor.** `editing-model.md`
argues it at length - a form is a typed lens over allowlisted fields, validated
before it writes; free-text editing of a compose file through a browser is the
editor tier with more privilege and fewer guards. Embedding `FileEditor` on a
settings page would quietly become exactly that.

---

## 5. Sequence

1. **Extract `FileContent`** from `DocBody`. Pure, no behaviour change, and the
   existing page is its first consumer - so it is provably correct if Files still
   renders every kind it did before.
2. **`FileView`** — adds the fetch and the empty/denied states.
3. **Use it once, on the service page**, showing that service's compose file
   read-only with a link into Files. That is the first real reuse and it proves
   the boundary is in the right place before anything is built on it.
4. **The new default view** for Files.
5. `FileEditor` only when something outside Files actually needs to write - not
   before. It is the piece with a role, a conflict check and a draft store, and
   extracting it speculatively means maintaining a boundary nobody is standing on.
