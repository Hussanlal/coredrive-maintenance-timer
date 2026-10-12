# Restricted CoreDrive maintenance timer

This repository intentionally publishes only timer/client code. The website and
application sources, customer data and hosting credentials are not here.

The timer can request two fixed operations on the CoreDrive website: expiry-only
operational hash cleanup and the existing metadata-only failure watchdog. Its
separate 256-bit bearer is held only in an Actions secret; the host stores only
its SHA256 verifier. It grants no enquiry read/export, arbitrary command, SQL,
file path, recipient, setting, pause/resume or deployment access.

Runs validate exact request-bound, source-bound completion receipts. The source
identity is the entire verified signed release-inventory digest, including
dependencies and runtime, plus the fixed supervisor hash. Network retries retain
the same nonce. The server serialises callers and charges its own
clock before spawning. The watchdog is attempted even when cleanup fails.
No secret or raw HTTP/helper response is printed or uploaded as an artifact.

The website checks successful cleanup AND watchdog receipts before accepting an
enquiry. Missing, failed, revoked, different-source or older-than-45-minute
receipts make the form unavailable; the static page and email alternative remain.
The separate no-secret readiness job reports this through normal workflow failure
notifications when it runs. Enable GitHub workflow failure notifications for the
operational owner and inspect private host metadata during recovery.

GitHub schedules are best-effort, not an uptime SLA. A same-platform readiness
job cannot guarantee notification of a GitHub-wide scheduler outage. Weekly UTC
repository activity is intended to avoid the documented public 60-day inactivity
disablement; inspect the actual commits and workflow state. If disabled, re-enable
the workflow manually, dispatch maintenance on the reviewed main branch, verify
new private receipts, and let a true scheduled run confirm recovery. Do not reset
quotas, delete held locks, or treat manual dispatch as an unattended proof.

Standard public GitHub Linux runners are free under current pricing; no artifacts,
caches, larger runners or paid services are configured. Check billing and scheduler
terms before changing that setup.

- [Schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
