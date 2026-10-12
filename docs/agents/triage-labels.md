# Triage Labels

The skills speak in terms of five canonical triage roles. In fenro each role is a label of the same
name, paired with a status. The status is what matters to agents: only `todo` tasks enter the ready
queue that `list_tasks ready: true` and `start_task` pick from.

| Role              | fenro label       | fenro status                                          | Meaning                                  |
| ----------------- | ----------------- | ----------------------------------------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | `backlog`                                             | Maintainer needs to evaluate this task   |
| `needs-info`      | `needs-info`      | `backlog`, with a hold naming who or what it waits on | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | `todo`                                                | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | `backlog`, so no agent claims it                      | Requires human implementation            |
| `wontfix`         | `wontfix`         | `cancelled`, with the reason as a `decision` note     | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), set both columns: swap the
label with `save_task` `add_labels` / `remove_labels`, then move the status and hold with
`set_status` (`hold: null` clears one). A new task is created as `todo` unless `save_task` passes
`status: "backlog"`, so file anything untriaged as `backlog`.

`save_task` creates a label that doesn't exist yet, so nothing needs creating up front.
