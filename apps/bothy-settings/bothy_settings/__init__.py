"""bothy-settings: the settings and secrets store, as a library.

See docs/plans/settings-store.md. This slice is the store only (schema, envelope
encryption, rotation, backup/restore, audit, refusals): no HTTP, no CLI, no wiring.
"""

from .errors import *  # noqa: F401,F403
from .store import (  # noqa: F401
    AtRestReport, BackupResult, BootstrapResult, Meta, RestoreReport, RotationResult,
    Store, bootstrap, restore,
)
