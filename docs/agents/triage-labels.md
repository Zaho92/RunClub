# Triage labels

Every open issue carries one label of each group: a kind, a state and, unless it is a sub-issue of an epic, a
priority.

## Kind

| Label | Meaning |
| --- | --- |
| `bug` | Something does not work as described. |
| `enhancement` | New behaviour or an improvement. |
| `epic` | A bundle of small related issues (sub-issues) that fit into one session together, roughly one to three hours of agent work. Its body says what connects them, the order, and one sentence per sub-issue. An epic is `bug` only if all its sub-issues are bugs, otherwise `enhancement`. |

## State

| Label | Meaning |
| --- | --- |
| `triage` | New; nobody has decided yet whether it is ready. |
| `needs-info` | Waiting for an answer from the reporter or the owner. |
| `ready-for-agent` | A spec or agent brief is on the issue; an agent can build it without questions. |
| `ready-for-owner` | Only the owner can do it (signing, a setting at GitHub, a decision). |
| `in-progress` | A run is working on it. Never propose or touch such an issue from another run. |

Discarded issues are closed as "not planned" with the label `wontfix`.

## Priority

| Label | Meaning |
| --- | --- |
| `prio-1` | Disturbs the owner's daily work or blocks something else. At most five `prio-1` pieces at a time, or it means nothing. |
| `prio-2` | Soon. |
| `prio-3` | Some day. |

Sub-issues of an epic carry no priority; the epic does.

## Mapping for the mattpocock skills

| Role in the skills | Label here |
| --- | --- |
| `needs-triage` | `triage` |
| `needs-info` | `needs-info` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-owner` |
| `wontfix` | `wontfix` |
