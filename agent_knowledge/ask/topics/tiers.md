# Performance tiers — what they are, why they matter

Apps Father runs every project on a chosen **performance tier**. The tier
controls which underlying AI models are used for the three paid steps
(plan / build / update / ask) and therefore the speed, code quality, and
cost. The owner picks one per project and can change it any time.

## What a tier actually is

Each tier is a bundle of:

- **Model choice** for plan, build, update, ask, and visual editor calls.
- **Reasoning depth** — higher tiers spend extra "thinking time" so they
  produce cleaner, more correct code on complex specs.
- **Per-step pricing in credits** — shown on every action button (Plan /
  Build / Update). The price scales with the tier.

Higher tier ≠ "always better". For a small CRUD app, Tier 1 is plenty and
costs much less. For a multiplayer game, a chat with rooms, or anything
with subtle business rules, a higher tier prevents the dreaded
back-and-forth of "fix this bug → broke that feature → regenerate".

## When to pick which tier

- **Tier 1** — default. Good for: simple lists, basic forms, single-screen
  apps, text bots with a handful of commands, MVPs and prototypes.
- **Higher tiers** — pick when:
  - The previous build had visible bugs or felt "off" architecturally.
  - The app has multiple interacting features (cart + checkout + admin,
    matchmaking + scoring + chat, etc.).
  - You need polished UX out of the gate (animations, edge cases, empty
    states, error messages handled gracefully).
  - You're scaling up and want fewer iterations per change.

## How a tier change feels in practice

- The Build / Update buttons display the new credit price the moment the
  tier is changed.
- Quality differences are most visible on **plans** (sharper structure,
  better feature scoping) and on **first-build code** (fewer retry loops,
  fewer "oops, that's not what I meant" moments).
- If the agent was producing similar code on Tier 1 and Tier 2 for a given
  app, you don't need the higher tier — drop back down to save credits.

## Cashback still applies

Picking a higher tier doesn't disable cashback. If a build comes in
cheaper than the pre-charge — even on a higher tier — the difference is
returned to the balance automatically.

## Asking the assistant

Owners can ask "what tier am I on?" / "should I bump the tier?" — answer
based on what's in `project_info` (the tier picked for THIS project) and
the size/complexity of what they're trying to build. Be concrete: if the
project has 2 screens and a list, Tier 1 is fine; if they're describing
matchmaking + a chat + a wallet, suggest a higher tier.
