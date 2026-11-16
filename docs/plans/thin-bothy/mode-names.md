# Mode names

_Status: **options, owner to pick.** Written 2026-11-16 after the owner asked for fun,
characterful names, and for `files` to be in the default._

## 1. Constraints (so fun does not hide information)

1. **The name is a label, the cost is the content.** Every mode shows its measured
   idle memory and disk next to its name ("Bivvy · about 1 GB"). The newcomer should
   be able to rank the modes without knowing the metaphor.
2. **The ladder must be obvious** without reading anything: smallest to largest.
3. **`files` is in the smallest mode.** The reading surface is the product; a first
   install that opens to a login and an empty Overview is a poor first minute
   (pragmatist review). The default shows a useful page: files plus a live health
   strip.
4. **Translatable.** Names are i18n keys, not literals (Hebrew, RTL, plurals; see the
   `hebrew-i18n` skill). A pun that only works in English needs a neutral subtitle.
5. **The custom mode is a first-class name**, not "Advanced".

## 2. Where the theme comes from

"Bothy" is a free, basic mountain shelter in the Scottish (and northern English,
Welsh) hills, kept up by volunteers. Facts worth borrowing (from the Mountain Bothies
Association's *Bothy Code* and general sources; historical dates vary between sources
and are not used here):

- **The shelter ladder is real:** a *bivouac* (bivvy: a bag and a waterproof cover,
  the most rudimentary), a *bothy* (four walls, free, primitive), a staffed
  *refuge/hut* (food and beds), with expedition *basecamps* as the staging point for
  bigger objectives.
- **The Bothy Code:** leave it as you found it; respect other users and the place;
  keep numbers down; **turn no one away**.
- **The logbook:** every bothy should have one; visitors write in it. (That is our
  **history / audit page**.)

## 3. Option sets

### Set A: the shelter ladder (recommended)

| Mode | Name | Tagline | Contents |
|---|---|---|---|
| mini | **Bivvy** | a roof, a door, a lock | k3s (or Compose) core, login, **files**, health strip |
| standard | **Bothy** | four walls and a fire | Bivvy + metrics, logs, alerts, backups |
| full | **Basecamp** | everything before the climb | Bothy + dashboards, SSO, Postgres, cluster UI, traces |
| custom | **Cairn** | stack your own stones | pick modules one by one |

Why it works: the order is intuitive even to someone who has never heard of a bothy,
the product is *named* Bothy so the middle rung is the brand, and "Cairn" (a pile of
stones hikers build to mark the way) is a natural name for "you choose the pieces".

### Set B: the evening in the hut (more playful)

| Mode | Name | Tagline |
|---|---|---|
| mini | **Kettle** | just enough to boil water |
| standard | **Fireside** | warm, with a logbook |
| full | **Ceilidh** | everyone is invited (a ceilidh is a Scottish gathering) |
| custom | **Tinker** | take it apart and put it back your way |

Funnier, but the ladder is less obvious (a ceilidh is not obviously bigger than a
fireside), so it relies on the shown cost to rank.

### Set C: a mix (my own tweak if you like both)

**Bivvy -> Bothy -> Basecamp**, with the playful voice carried by the *microcopy*
instead of the names (section 4), and **Cairn** for custom. Best of A's clarity and
B's charm.

## 4. Microcopy that makes it feel like a system with a personality

These map real features to the bothy world. Each keeps the plain meaning in a
subtitle so no one is lost.

| Feature | Bothy-flavoured text | Plain meaning (subtitle) |
|---|---|---|
| First-run wizard title | "Where will you sleep tonight?" | Choose a mode |
| Admin password screen | "Your key to the door. You will only see it once." | One-time generated password |
| History / audit page | **The Logbook** | who changed what, and when |
| Settings -> Modules | **The Hut** (or "Provisions") | modules you can add |
| Disable vs purge | "Close up" vs "Clear out" ("leave it as you found it") | stop it, keep data / delete data |
| Uninstall | "Leave no trace" | removes everything it created, per the receipt |
| Failed update, rolled back | "Weathered it out; back where we were" | automatic rollback |
| Budget refusal | "No room in the hut: this needs 600 MB, you have 410 free" | budget gate |
| Viewer role | **Visitor** | read-only |
| Healthy overview | "All quiet in the glen" | everything is up |
| Alert | "Smoke on the ridge" | something needs attention |

Guard rails: **no joke in an error that blocks someone mid-task**; fun lives in
empty states, titles, success messages and the first run. Destructive actions say
exactly what they do before any flavour.

## 5. What to decide

| # | Decision | Recommendation |
|---|---|---|
| N1 | Which set | **C**: Bivvy / Bothy / Basecamp / Cairn, with the microcopy in s4 |
| N2 | Is "Visitor" the viewer role's display name? | yes in the UI; the role stays `viewer` in code and policy |
| N3 | Do we adopt "The Logbook" for the history page | yes |
| N4 | Mascot or illustration | later; the design skills in this repo apply |

Names are **display strings only**. Module ids, role names, route names and mode ids
in code stay plain (`mini`, `standard`, `full`, `custom`) so renaming the fun layer
never touches logic.

## Sources

- [Bothy (Wikipedia)](https://en.wikipedia.org/wiki/Bothy)
- [Scotland's Bothies (Hidden Scotland)](https://hiddenscotland.com/articles/scotland's-bothies)
- [Mountain hut (Wikipedia)](https://www.wikipedia.com/wiki/Rifugio)
- [The Different Types Of Shelters Used By Mountaineers (WorldAtlas)](https://www.worldatlas.com/articles/the-different-types-of-shelters-used-by-mountaineers.html)
- [What is a hut? A pictorial romp and an initial typology (hut2hut.info)](https://www.hut2hut.info/what-is-hut/)
