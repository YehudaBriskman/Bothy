"""Code the two Bothy backends share, once.

    audit     the append-only TSV log every tier writes
    http      the stdlib server, the JSON answer, the CSRF gate, the actor
    names     "is this a name, or a path wearing one" - always fullmatch
    safepath  the path boundary (bothy-files only; ops never imports it)

It was four copies before 2026-09: bothy-files, bothy-config, bothy-control and
bothy-kube each carried their own audit(), _send(), CSRF block and server
boilerplate, and bothy-config carried a trimmed COPY of safepath.py whose own
header admitted "the drift risk is real". A copy is a place to fix a hole in one
service and not the other; one module is not.

STANDARD LIBRARY ONLY, and that is not negotiable here. Both images COPY this
package in, and bothy-ops holds a path to the Docker daemon and a cluster token:
a dependency added to this package is a dependency added to that process. The
one third-party library on either side (ruamel.yaml, bothy-files' config
patcher) is imported by bothy-files/yamlpatch.py and never from here.
"""
