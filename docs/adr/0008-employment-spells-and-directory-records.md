# Employments are spells, can exist without an account, and end only by hand in a Directory organization

This amends [ADR 0004](0004-attendance-is-org-scoped-via-employment.md), which made the Employment
"one row per person per organization", written on every path that joins someone to an organization
and ended when they lose their last link. The people directory (fenro T-466, decisions T-472 to
T-483) needs three things that rule does not allow, so all three changed.

**One row per spell.** A person who leaves and comes back gets a new Employment; an ended row is
never reopened. Each spell keeps its own dates, Profile, retention clock and Read log rows, so a
rejoin neither rewrites what the organization held about the earlier spell nor restarts the clock
that purges it. Only one spell per person is open at a time. A spell belongs to the same person when
it carries the same account, or, when either spell has no account, the same email
(`samePersonAs` in `src/services/employment/personSpells.ts`); Copy from previous spell, the Person
export and the Read log filter all use that rule.

**Records without an account.** HR can add a person who has no account yet (`createDirectoryPerson`,
`user_id` null, the Employment's own name and email copy). No join path writes such a row, and no
link holds it. A directory invite binds it to an account later (the Claim), and until then the
email copy is unique among the organization's open Employments, so a join path refuses to open a
second record for that address (409 `ACCOUNTLESS_EMPLOYMENT_EMAIL`).

**No ending on link loss in a Directory organization.** There `syncEmployment` opens a spell on a
new link and never ends one: removing someone's last group, revoking an admin grant or changing a
manager leaves the Employment open, and only End employment closes it. HR manages these records, and
a link change that quietly ended one would also start its retention clock. With the directory off
the derived rule from ADR 0004 applies again, and records that no link holds stay open until an
admin ends them.

The alternative was to keep one row per person and reopen it on a rejoin, with the spells kept in a
child table. It keeps ADR 0004's invariant and the existing roster queries, but every Profile,
photo, retention clock and Read log row would then need a spell key of its own, and erasing one
spell would mean deleting rows out of a live record. A row per spell gets all of that from the
Employment id. The cost is that "the person's Employment" is no longer a single row: readers either
take the open spell or walk every spell by the rule above.

## What would reverse this

Deciding that the directory should keep no history across a rejoin, or that HR records must always
belong to an account. Then a person would again be one row, and Add person would become an invite
that opens nothing until it is redeemed.
