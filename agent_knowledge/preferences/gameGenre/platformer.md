GENRE = Platformer.

- Side-scrolling. Player jumps between platforms, avoids hazards, reaches a goal or chases a score.
- Physics: simple verlet or step-based integrator. Constants (tune in plan, do not pick by feel):
  - `GRAVITY = 0.6` (units/frame²)
  - `JUMP_VELOCITY = 11` (units/frame)
  - `MOVE_SPEED = 5` (units/frame)
  - `MAX_FALL_SPEED = 18`
  Convert to per-second equivalents and multiply by `dt * 60` so behaviour is frame-rate independent.
- Coyote time (~100ms after leaving a platform you can still jump) and jump buffering (~150ms — pressing jump just before landing still triggers).
- Collision: AABB vs platforms only. Resolve Y-axis after X-axis to avoid wall-climb glitches.
- Camera: follows player horizontally with a deadzone. Smooth vertical follow only after the player lands.
- Levels: hand-authored `levels[]` arrays of `{ x, y, w, h, type }` rectangles. Procedural generation is acceptable but the plan must specify the chunk schema.
- Goal flag / portal at the end of each level. Reaching it unlocks the next level (persisted via `CloudStorage`).
