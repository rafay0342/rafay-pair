# Service-level objectives

These objectives govern production alerting and release decisions. Planned maintenance announced at least 48 hours in advance is reported separately but is still visible in availability dashboards.

| Signal                            |                                                               Objective |          Window |
| --------------------------------- | ----------------------------------------------------------------------: | --------------: |
| Authenticated API availability    |                                99.9% successful non-user-error requests | rolling 30 days |
| API latency                       | 95% under 300 ms and 99% under 800 ms, excluding media-provider traffic |  rolling 7 days |
| Care-request durable acceptance   |                                                    99.9% under 1 second | rolling 30 days |
| Partner derived-event delivery    |                         95% under 1 second when both clients are online |  rolling 7 days |
| Privacy-pause server propagation  |                     99% under 2 seconds; local enforcement is immediate | rolling 30 days |
| Pair-disconnect access revocation |                          100% before the disconnect transaction commits |   every request |
| Outbox delivery                   |                                                 99.9% within 60 seconds |  rolling 7 days |

The monthly availability error budget is 43 minutes and 49 seconds at 99.9%. Feature releases pause when more than half of the monthly error budget is consumed in seven days or when any consent, privacy, authentication, or scientific-honesty invariant is violated.

PostgreSQL uses point-in-time recovery with a production recovery-point objective of five minutes and a recovery-time objective of sixty minutes. Redis contains no consent truth and may be rebuilt. Backup restoration is rehearsed monthly in an isolated account, including application-level authorization checks against the restored data.
