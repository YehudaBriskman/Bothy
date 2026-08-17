# Brand core

_Status as of 2026-08-10._

The name, who it is for, and how it speaks. Everything else in this tree is
downstream of this file.

## The rule

**Pick a name nobody else in your space has taken, and check.** Not "it sounds
unused" - actually search for it as a software project, on the package
registries you would publish to, and as a product. Record where you looked and
when, because "it was free in 2026" is the useful form of that claim.

**Write one canonical description string, and use the same bytes everywhere.**
The page description, the manifest description and the repository description
should be byte-identical. Three near-identical sentences is how a product ends
up describing itself three slightly different ways, and it is invisible until
someone sees two of them side by side.

**Decide the voice as three adjectives and three anti-adjectives.** The
anti-adjectives do more work than the adjectives - "not chatty" is actionable
in a way that "clear" is not.

**Own your vocabulary.** One word per concept, and a written boundary between
words that are nearly synonyms. The state words are the ones that always go
wrong: if "down" and "stopped" are not defined against each other, they will be
used interchangeably and the interface will lie.

## Checklist

See [CHECKLIST.md § 2](../CHECKLIST.md#2-brand-core).

## What Bothy decided, and why

**The name.** Bothy. A bothy is a small hut in the Scottish hills, left
unlocked, that anyone can shelter in. That is what the box is: one machine that
quietly holds everything, open to anyone on the tailnet, not a service anybody
sells.

It was chosen from a shortlist that was checked against existing software
before it was proposed. Rejected because they are taken: Orrery (three separate
projects), Plinth (a PHP framework, a language, and the FreedomBox web UI),
Rookery (an attestation monorepo and an AT Protocol server), Halyard (Merck's
triplestore and Spinnaker's config tool), Belfry (the BelfrySCAD OpenSCAD
libraries), Windrose (a Python plotting library and a game-server toolchain),
Vireo (Twitter's video library, an NI runtime, a thesis-management system),
Byre (two projects), Dovecote (a PaaS). Bothy, Steading and Undercroft came back
clean on 2026-08-10; Bothy won on length.

**What it replaced, and why the old one was wrong.** The topbar used to read
`the name layer / dev box`. That named the product after a DNS name which had been
dormant since 2026-08-08, when access moved to pure IP:port. So for every
current visitor the brand line stated an address that did not resolve. The
wordmark is now the product's own name, and the line under it is read from
`location.hostname` at run time - the bare address, whatever the visitor
actually typed. It is also never written into the repository, which is public.

> **Update 2026-08-12.** The name layer was not merely dormant - its
> configuration was **deleted** on 2026-08-12, and Traefik now holds zero
> `Host()` rules. The rename was written on 2026-08-10 while the name was still
> theoretically revivable, which is why the sentence above originally read "it
> shows the name layer if you arrived by name". No visitor can arrive by name any
> more, so `location.hostname` now always renders the bare IP. The decision
> needed no revision, which is the point of it: the wordmark never depended on
> the address in the first place. What the deletion changed is only the *value*
> the subtitle happens to print.

**Description string.** "The dev box, and everything running on it." Used
identically in the page description and the manifest.

**Voice.** Precise, plain, unhurried. Not chatty, not reassuring, not clever.
The interface is read by one person who already knows how the box works and
wants a fact; it should not perform friendliness at them.

**Vocabulary the product owns.** The state words are defined against each other
and the boundaries are load-bearing:

| Word | Means | Does not mean |
|---|---|---|
| `up` | Running, and confirmed so | - |
| `down` | Meant to be up and is not - a non-zero exit, a restart loop, an unhealthy check | Switched off |
| `stopped` | Switched off on purpose - a clean exit, created, paused | Broken |
| `unknown` | **We have not checked.** A statement about the portal's knowledge | Broken |
| `starting` | Confirmed to be coming up | - |

**Never say:** "down" for a service somebody deliberately stopped. That single
misuse put five containers and six routes into a "needs attention" list, none of
which was a problem, and it is the reason the boundary above is written down.

**The distinction between "the box" and "Bothy".** Bothy is the portal - the
interface. The dev box is the machine. The knowledge base and the repository
README correctly say "dev box" throughout and were deliberately not renamed.

## Dead ends

- **Naming it after the hostname.** the name layer was the name for a year. It broke
  the moment the access model changed, which is the general lesson: do not name a
  product after an address, because addresses change and names should not.
  Confirmed the hard way on 2026-08-12, two days after the rename: the name
  layer was deleted outright. Had the rename not already happened, the wordmark
  would have been a dangling reference in the product's most prominent position.
- **Picking a name without checking.** The first four candidates that felt right
  were all taken by real projects. Checking took one round of searches and saved
  a rename.
