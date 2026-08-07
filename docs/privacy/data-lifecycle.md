# Data lifecycle

RafayPair collects the minimum data required for the action the user starts. Pairing does not implicitly enable a sharing scope. Raw pose and pulse frames remain on device, and raw breathing-session audio is not retained. Care notes and approved derived events are encrypted in transit and at rest.

| Data                                 |                                                      Default retention | User control                                    |
| ------------------------------------ | ---------------------------------------------------------------------: | ----------------------------------------------- |
| Access sessions                      | 15 minutes; revoked session hashes retained 30 days for replay defense | sign out all devices                            |
| Refresh sessions                     |                                          30 days maximum with rotation | sign out or account deletion                    |
| Expired/used pairing-code hashes     |                                                               24 hours | automatic deletion                              |
| Consent and privacy audit            |                                7 years, append-only, restricted access | export; legal erasure exceptions documented     |
| Care requests                        |                                                1 year after resolution | delete individual item or account               |
| Workout/derived physiology summaries |                                                    until user deletion | delete item, export, or account                 |
| Realtime transient state             |                                           minutes; never authoritative | privacy pause/disconnect immediately removes it |
| AI audio buffers                     |            session transport only; no application recording by default | end session immediately                         |
| AI transcript/memory                 |                     off by default; explicit flag and per-item control | inspect, delete item, disable, erase account    |
| Security logs                        |                          90 days hot, 1 year archive, content-redacted | governed access                                 |

Account deletion immediately revokes sessions, disconnects the pair, stops realtime/AI access, disables notifications, and queues durable erasure. Primary records are deleted within 30 days. Encrypted backups expire on their normal schedule within 35 additional days; deleted records are not restored into active service during recovery. Legal retention applies only to the minimum immutable record and is not available to product features.

Exports are generated asynchronously, encrypted, expire after 24 hours, and require recent authentication. They include account, pair history, consent changes, care, workouts, measurements with provenance, AI memory, and deletion history without exposing the former partner's private records.
