# Assistant usage: retention and reconcile

The meter's ledger (`assistant_model_calls`, one row per metered step) and the daily AI connection
counters (`ai_connection_daily_calls`, `ai_connection_member_daily_calls`) are kept 90 days. Before
they go, each finished week becomes a Weekly total. The code is
`src/services/aiFeatures/aiUsageRetention.ts`.

## The nightly tick

`runAiUsageRetention` runs on the quota rollover tick after the other sweeps, under a transaction
advisory lock, so a second instance skips. In order:

1. **Roll.** Every finished UTC week whose rows are all still kept (its Monday is less than 90 days
   back), and any finished week never rolled, is recomputed from scratch into
   `ai_usage_user_weeks` (one row per person: Usage and AI connection calls) and
   `ai_usage_organization_weeks` (Usage, calls, and `limit_reached_at`, when the running total
   first passed the Weekly limit then in force). Recomputing keeps a late settle and an Erase
   consistent.
2. **Delete** ledger rows created more than 90 days ago, counter rows for days before that, and
   rejected turns older than 180 days.
3. **Fold.** Per-person weekly totals whose week starts more than 180 days back go. The
   organization row already holds their sum; a missing one is written from them first.

Organization totals stay until the organization is deleted (they cascade).

The AI usage page reads a week from the ledger while the ledger holds it, and from the Weekly
totals after that (`readAiUsage`, `readAiUsageWeek` in `aiUsageServices.ts`). The per-person split
is shown while the week starts within 180 days.

## Erase and account deletion

- **Erase** (`eraseEmployment`) calls `eraseAiUsage`: the organization's ledger rows and weekly
  totals for the person drop the user and keep the cost; their daily AI connection counts and
  rejected turns in the organization are deleted. Organization totals do not change.
- **Account deletion** strips the user row and keeps its id, so the rows stay on the Deleted
  account.
- **A member leaving** changes nothing here.

## Monthly reconcile

Run by hand once a month, after the month has closed, against the database of the deployment
whose Anthropic workspace you compare:

1. Fetch the month's cost report with an Admin API key (the key never goes in this repo):

   ```bash
   curl "https://api.anthropic.com/v1/organizations/cost_report?starting_at=2026-10-01T00:00:00Z&ending_at=2026-11-01T00:00:00Z&group_by[]=workspace_id&group_by[]=description&limit=31" \
     -H "anthropic-version: 2023-06-01" -H "x-api-key: $ANTHROPIC_ADMIN_KEY" > cost-2026-10.json
   ```

   If `has_more` is true, fetch again with `page=<next_page>` and save the pages as one JSON array.

2. Compare:

   ```bash
   pnpm run assistant:reconcile --month 2026-10 --report cost-2026-10.json --workspace <wrkspc_id>
   ```

The command sums the ledger's Usage (settled, or reserved where never settled) for rows created in
the UTC month, per model, against the report's `tokens` costs for that workspace. Session runtime,
web search and code execution are outside the meter and left out. Drift above the larger of 2% and
$1 logs `assistant.reconcile_drift` at error level and exits 1. It also lists the month's
reservations older than 15 minutes: steps that crashed before settling and stay charged at their
reservation.
