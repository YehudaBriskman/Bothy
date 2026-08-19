# Bothy Files

`http://<node-ip>/#/files`. Every document on the box, read straight off the
disk it lives on - rendered, searchable, linkable and editable. No second copy,
no sync lag, nothing to keep out of git.

One nav entry, two destinations, and they take the same `?root=` and `?path=`
so an existing deep link resolves in either:

- **`/files`** is a **reader**. A document, an index of documents, and its own
  headings.
- **`/files/edit`** is the IDE - an activity bar, a tree, resizable panes,
  source control, and a real code editor.

The reader is the default because the tax of four regions was being paid on
every read by everyone, to make the rarer case one click cheaper. The line the
reader is built around is worth quoting, because it is a structural claim rather
than a promise:

> **Reading mode never writes.** Not "does not write yet". No draft, no dirty
> flag, no conflict check, no save, no local storage key.

Nothing in the reader's import graph reaches the write path at all, which is
also why it never downloads the code editor's chunk. Its answer to every request
for a save button is the Edit button, which is a link.

## The four roots

A root is a **named place**. Clients send the name, never a filesystem path, so
there is no default and no way to ask for "the whole disk". They are declared in
[`apps/portal-files/policy.toml`](../../apps/portal-files/policy.toml), and a
root declared there but not mounted in compose is a startup error rather than an
empty directory - a silently empty root reads as "nothing to see".

| Root | What it is | Writable |
|---|---|---|
| `stacks` | this repository | yes |
| `notes` | your notes repository, wherever `NOTES_ROOT` points | yes |
| `projects` | everything under `PROJECTS_ROOT` | no |
| `home` | "any folder you can cd into" | no |

`projects` is read-only twice over - the application refuses with a readable 403
and the mount is `:ro`, so the kernel refuses regardless. Project repositories
have their own review and CI, and an edit here would bypass both.

`home` is read-only for a different reason: it **overlaps** `stacks` and
`notes`, so the same file is reachable under two names and only one of them
should be able to change it. It is also excluded from a search across all roots,
because every hit in the other three would otherwise come back a second time
under a `home/...` path - and the second copy is the one whose root cannot be
written to, so clicking it opens a read-only view of a file that is editable
elsewhere.

Every top-level dot entry in the `home` root is denied as a class. A survey
before mounting it found live OAuth credentials, a GitHub token, SSH and GPG
keys, kube and docker credentials, minikube CA private keys, shell history and
roughly 165,000 cache files - **all of them top-level dot entries**. Denying the
whole class is one auditable rule instead of a list that needs a new line every
time a tool is installed, and dot entries *below* the top level are still
served, which is what keeps `.github/` inside a repository openable. The rule is
per-root, because it would be wrong for a repository: `.gitignore` and
`.env.example` are things you open on purpose.

## What is never served, and what is served with a label

**Never, at any depth, in any root:** `.git`, `.ssh`, `.gnupg`, and a list of
build and cache directories. `.git` is the security one - it holds the object
store and a config that can carry a credential. The rest are volume: tens of
thousands of files nobody browses, which make the explorer useless and the
listing slow. Both reasons matter.

**Served, but labelled:** files matching the sensitive patterns - `.env`, keys
and certificates, `*secret*`, `*password*`, `realm-*.json` and the rest. This
changed on 2026-08-17 from a refusal to a label, and the argument is worth
reading before assuming it was careless. This is one box, reached over a
tailnet, owned by the person reading it, and a file explorer that hides the
owner's own `.env` from them is not protecting anybody - it teaches them that
Bothy cannot be trusted with the interesting half of the box.

> [!warning] One consequence that is not "my box, my files"
> `.env` contains `OAUTH2_COOKIE_SECRET`. Anyone who can read it can mint a
> session cookie for any role, so on this deployment `viewer` is worth the same
> as `operator`. That is fine while one person holds all four roles and it stops
> being fine the moment a second person holds only `viewer`. If that day comes,
> the answer is a role gate on the sensitive list, not a return to hiding files.

There is a second list for patterns that describe a *word* rather than a file
format. A documentation page called "Change Password.md" was being marked as a
secret; `.md` and `.rst` are formats you write *about* credentials in, whereas
`.txt` deliberately is not, because `db_password.txt` is exactly the shape of a
file somebody leaves a credential in. And `.env.example` is explicitly exempt -
it is the file you read to learn what to set, so marking it would be crying wolf
on the one `.env`-shaped file that is safe by construction.

## Reading

The markdown reader is a **deliberately small hand-written subset**, built as
React elements and never as an HTML string. That is what makes rendering
arbitrary repository content safe with no sanitiser: there is no `innerHTML`
anywhere, so every scrap of file content is escaped whether or not the parser
understood it. Anything it does not understand falls through as literal text,
and the Source toggle is one click away, so a mis-parse is cosmetic.

What it renders: headings, fenced code with syntax highlighting, blockquotes,
horizontal rules, lists, GFM tables, and inline code, emphasis, links and
images.

What it adds beyond that:

- **Wikilinks.** `[[dns]]`, `[[network/dns]]`, `[[dns#ttl]]` and
  `[[target|label]]`. They resolve against the index of documents that actually
  exist - by exact path first, then by adding a known extension, then by
  basename case-insensitively, preferring the shallowest match. A wikilink that
  resolves to nothing renders inert with its target visible, and never as a live
  button, because an unresolvable link rendered as resolved is the worst of the
  three possible answers.
- **Callouts.** `> [!note]`, `[!tip]`, `[!important]`, `[!warning]`,
  `[!caution]`, with an optional title after the marker. Obsidian's syntax and
  GitHub's, deliberately rather than an invented one: notes here are read in
  this reader *and* elsewhere, and a note that renders as a panel in one and as
  a literal `[!warning]` in the other is worse than plain prose in both.
- **Backlinks and an outline**, and media rendered inline from disk. An image
  becomes an image, an `.mp4` becomes a video and an `.mp3` becomes an audio
  player - with controls, never autoplay, because a clip that starts itself in a
  reading view is a jump-scare and, on a tailnet link, somebody's bandwidth. A
  PDF or an HTML file stays inert on purpose: those are *document* contexts, and
  the guarantee this renderer makes is meant to hold by reading this renderer.

Three things it will not do, each on purpose:

- **Raw HTML is never interpreted.** A line starting with a tag is consumed to
  the next blank line and rendered as an inert chip naming the tag. Interpreting
  it would mean turning file content into markup, which is the one thing this
  renderer exists not to do. If you are writing documents to be read here, write
  markdown, not HTML.
- **Remote images do not load.** The content security policy blocks them, and
  widening it would let any document in any root make the reader's browser talk
  to a third party - on a box reached over a tailnet, an image tag is an
  IP-address beacon. They render as a compact chip instead, which is what keeps
  the top of a README with three badges in it from becoming a wall of query
  strings.
- **Mermaid is not executed**, for the same reason. A fence tagged `mermaid`
  renders as what it literally is. Diagrams in this repository therefore live as
  mermaid *sources* under `docs/diagrams/`, are rendered to SVG by
  `just diagrams`, and are embedded as ordinary images - an SVG loaded through
  an image element is an image context, with no script and no external
  references, so the picture arrives with no new attack surface. A check
  compares a hash the generator writes into the SVG, so a source and its picture
  cannot drift.

Reading requires the **`viewer`** role. That was not always true, and the change
is documented at the top of
[`edge/dynamic/portal-files.yml`](../../edge/dynamic/portal-files.yml): reads
were open while the roots were two markdown trees of published documentation,
and that reasoning died when the roots widened to "the box".

## Searching, history and downloads

Full-text search runs through the same walk the reader does - the same
deny rules, the same per-root rules - and that sameness is a security property
rather than an implementation detail. `safepath.collect()` is the **only** way
the application can learn a set of paths, so a new endpoint inherits the rules
by calling it rather than by its author remembering to.

It was learned expensively twice. First a listing that did its own walk paid for
30,093 refused files to serve 3,474. Then, when search was added, the same
shortcut would have returned a matching **line** out of `.env` - the deny list
would still have been correct, and the secret would still have been on screen.
A check plants a credential-shaped token in three kinds of denied file and
requires that only the served one comes back.

Git history and a diff view are available per file where the root is a
repository. `/git/diff` changes nothing, so it sits on the read router; the git
*action* routes - stage, commit, pull, push - were removed on 2026-08-15 along
with the tier they needed.

Raw bytes and archive downloads are served on **`:8100`, never on `:80`**, and
that is the security control rather than a deployment detail. A different port
is a different origin, so a hostile SVG or PDF served there cannot read the
portal's DOM or any response from the JSON API. Nothing else may ever be routed
to that entrypoint. An unauthenticated download there gets a bare 401 rather
than a sign-in page, deliberately: a login form rendered on the sandbox origin
would be a document on the origin that exists to hold none.

Reads are capped at one megabyte - a megabyte of markdown is already an
unreasonable page. `/raw` is wider in bytes, because it sends binaries and files
above that ceiling, but the file **set** is identical, since both go through the
same resolver.

## Writing

Writing needs the **`editor`** role. A save writes straight to the working tree.
There is no commit step; the git verbs were removed with the tier that gated
them.

Four things happen on every write, and none of them happens if you edit the same
file another way:

1. the **role gate** at the edge;
2. a **conflict check** against the modification time the editor loaded, so a
   stale tab cannot silently revert somebody's afternoon;
3. a **snapshot of the outgoing bytes** - the last 20 states per file, kept 30
   days;
4. an **audit line** naming who did it, from the session rather than from
   anything the browser sent.

The snapshot directory is declared in policy and checked at startup like a root,
because a snapshot directory that is not mounted would leave the undo net
silently absent - and a safety net nobody notices is missing is worse than none
at all.

### There is no extension allowlist, and that was a decision

There used to be one - markdown, text, SVG, HTML and a few others - justified as
a blast-radius limit. It was removed on 2026-08-17, and the argument is the one
worth carrying:

> The allowlist did not stop the dangerous edit. It stopped the dangerous edit
> from being **safe and attributed.**

Bothy is dev-box tooling for the person who owns the box. If they want to edit a
compose file and restart it, that is the job. A tool that refuses is a tool they
work around with `vim`, which has none of the four properties above.

What is still refused is different in kind: the deny list (files this service
must never hand out at all, read or write), anything outside a root or reached
through a symlink, the read-only roots, and anyone without the role.

### In place of refusing, it tells you what will happen

Every path can carry a **caution** - a level and a sentence, shown before the
save. They refuse nothing. The notes say what breaks and how it is noticed,
because a warning that does not name a consequence is decoration and it trains
people to click past the ones that matter. A few, to give the shape:

| You are editing | What it says |
|---|---|
| `edge/dynamic/*.yml` | a doubled brace, comments included, voids the whole file and nothing errors |
| any `compose.yml` | a changed label or port does nothing until the container is **recreated**; editing is not applying |
| `.env` | nothing is live until the stack is brought up again, and two values bite harder than the rest |
| any `policy.toml` | this is the access model for the service about to write it, and it fails closed |
| `scripts/**`, `justfile`, workflows | this is not configuration, it is code something will execute without asking again |
| an HTML or SVG file | a script inside it runs in whatever application serves it, with that application's session |

### What is genuinely missing

If an edit breaks something, the repair paths are the snapshot and git, and both
are file-level. **There is no terminal in Bothy** - `shell` is a role granted to
nobody - so a change that stops a container from starting is repaired from a
real shell on the box. That is the gap a terminal would close, and it is the
honest reason to build one. See [Roles](roles.md).

## Related

- [Themes](themes.md) - the theme editor writes its file through this tier
- [The files you will actually edit](configuring.md) - what those cautions are warning about
- [`apps/portal-files/policy.toml`](../../apps/portal-files/policy.toml) - the policy itself, which is the reference for all of the above
