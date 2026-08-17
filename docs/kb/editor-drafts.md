# Unsaved edits: where they live and what can lose them

Design note for the portal's file editor. Written 2026-08-13, before the code, so
the trade is a decision rather than an accident.

## The question

You type into a file and do not press Save. Where does that text live, what
survives, and what happens when the file underneath you changes?

Today the answer is: **memory only.** The draft lives in React state, a
`beforeunload` handler warns you, and a reload loses everything. That is honest
and it is also the weakest possible answer - a reload is not an unusual event, and
the warning is a browser dialog most people dismiss by reflex.

## What we are choosing between

| | survives reload | survives a stale draft | complexity |
|---|---|---|---|
| memory only (today) | no | n/a | none |
| `localStorage`, keyed by path | yes | **no** | low |
| `localStorage` + base mtime | yes | yes | low-ish |
| IndexedDB + full history | yes | yes | high |

The middle option is the trap, and it is the one most editors ship first.

**A draft saved without the mtime it was based on is a silent overwrite waiting
to happen.** You edit `README.md` in a tab, forget it, and three days later `git
pull` rewrites that file. Reopening the tab shows *your* draft, looking current.
Press Save and you have reverted three days of someone else's work, with a commit
in your name and no indication anything was lost. Nothing in the UI ever said the
word "conflict".

## Update, 2026-08-13: the server enforces this too

When this was written, a save WAS a git commit, so git was a safety net - a
clobber sat in the object store and was recoverable. Save now writes straight to
disk, which removes that net entirely and promotes the mtime check from a client
courtesy to **the only thing standing between a stale tab and lost work**.

So `/write` takes the `baseMtime` the client read and refuses with `409` if the
file moved underneath, returning BOTH versions. The client still keeps drafts as
described below; the difference is that the server no longer trusts it to.

`baseMtime` is optional on the API - a script or a curl has no mtime to send and
is not blocked - but the UI always sends it, so the guarantee always applies
where the risk actually lives.

## The decision

**`localStorage`, keyed by `root + path`, storing the draft AND the `mtime` it
was based on.**

On open, three cases, and each gets a different UI:

1. **No draft** - normal open, no banner.
2. **Draft exists, disk mtime == the draft's base mtime** - restore silently, mark
   the file dirty. Nothing changed underneath you; this is just your tab
   surviving a reload, which is what you expect.
3. **Draft exists, disk mtime != base mtime** - this is the conflict. Do NOT show
   the draft as if it were current, and do NOT discard it. Show both, name what
   happened, and make the user choose: keep mine, take theirs, or view the
   difference.

Case 3 is the entire reason for storing the mtime. It costs one number.

## Rules that follow

- **Save clears the draft.** Once it is a commit, git is the record and a
  lingering copy in the browser is a second source of truth that can only ever
  disagree.
- **Drafts expire after 14 days.** An unbounded store fills up and, worse, makes
  case 3 more likely the longer it sits. Expiry is a courtesy, not a feature -
  the conflict check is what makes it safe.
- **`localStorage`, not `sessionStorage`.** Surviving a tab close is the point.
- **One draft per file, not per tab.** Two tabs on one file already share the
  same disk file; pretending otherwise invents a conflict between you and
  yourself.
- **Never store a draft for a file the server called read-only.** It cannot be
  saved, so keeping the text only builds a promise that will be refused.
- **Quota is a real failure mode.** `localStorage` is ~5 MB and a draft can be 1
  MB. On `QuotaExceededError`, drop the oldest drafts and tell the user in the
  Problems panel - failing silently here means the one thing the feature promises
  quietly stops being true.

## What this deliberately does not do

- **No autosave to disk.** Every save is a commit; autosaving would produce a
  commit per keystroke-pause and turn `git log` into noise. The draft is the
  autosave, and it stays client-side until you mean it.
- **No cross-device sync.** Drafts are per-browser. Syncing them would need
  server-side storage, which means the write tier holds unreviewed content -
  a much bigger change than it looks.
- **No merge.** Case 3 offers keep/take/compare, not a three-way merge. If you
  want to merge, that is what the repo is for.

## What still loses work

Stated plainly, because a design that claims to lose nothing is lying:

- clearing site data, or a different browser
- private-browsing windows
- a draft older than 14 days
- exceeding quota with several large drafts open

None of these are silent under this design except the last, which is why it
reports.
