# Internationalisation

_Status as of 2026-08-10._

## The rule

**Decide whether the product is single-locale, and record it.** "Single locale"
is a legitimate answer. An unrecorded one is not, because the cost of reversing
it grows quietly.

**Some of it is free now and expensive later.** Do these regardless of the
decision:

- **Logical CSS properties** - inline and block rather than left and right.
  Identical effort today, and it is most of what a right-to-left conversion needs.
- **Format numbers, dates and lists with the platform internationalisation
  API**, never by hand. It is not more code, and hand-rolled formatting is where
  locale bugs live.
- **No sentences assembled by concatenation.** Word order is not universal, and
  a concatenated sentence cannot be translated even in principle.
- **No translatable text baked into images.**
- **Language and direction attributes** on the document.

**The rest can wait**, and should be recorded as waiting: right-to-left mirroring
of direction-implying icons, a font stack covering the scripts in scope, and
layout headroom for text expansion of roughly 40 percent.

## Checklist

See [CHECKLIST.md § 26](../CHECKLIST.md#26-internationalisation).

## What Bothy decided, and why

**Single locale, English, deliberately.** The product is a private dashboard
read by one person on one machine. Nothing about it argues for translation.

**What is done:** the document language is set.

**What is not, and should be anyway:** the stylesheets use physical properties
throughout. That is the "free now, expensive later" item, and it was not taken.
Number and byte formatting is hand-rolled rather than using the platform API -
defensible for byte sizes, which have a house rule, less so elsewhere. Tracked in
[reference/open-questions.md](../reference/open-questions.md).

## Dead ends

None recorded.

## How this is verified

- Assert the language and direction attributes are present.
- Grep for physical CSS properties once the migration is agreed.
- Run a pseudo-locale pass with lengthened strings and screenshot it.
