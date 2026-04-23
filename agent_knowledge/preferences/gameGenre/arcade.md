GENRE = Arcade.

- Short loops (30s-2min). Score-chasing. Instant restart.
- Single screen of action — no camera scroll, no level progression. Difficulty ramps over time within the same run.
- State machine: `idle (tap to start) → playing → game over (tap to restart)`. The game-over overlay shows score + best.
- Increase difficulty linearly with elapsed time: spawn rate, enemy speed, number of obstacles. Cap at a sane maximum so it stays playable.
- Persist `bestScore` via `Telegram.WebApp.CloudStorage`. Compare and update on game over. Trigger `HapticFeedback.notificationOccurred('success')` on a new best.
- Forbid: lives systems, currency, multi-stage progression. Arcade = one life, one score, one tap to retry.
