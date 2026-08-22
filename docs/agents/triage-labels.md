# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Provisioning the labels

Only `wontfix` exists on this repo today — it ships with GitHub's default set. The other four do
not, and `gh issue edit --add-label` fails on a label that isn't there rather than creating it.

Before applying one for the first time, check and create it:

```bash
gh label list --json name --jq '.[].name' | grep -qx '<label>' \
  || gh label create '<label>' --description '<meaning from the table above>'
```

If creation fails — most often no write access on a fork — say so and leave the issue unlabelled.
Never invent a near-miss name to work around it; a label nobody queries for is worse than none.

Edit the right-hand column to match whatever vocabulary you actually use.
