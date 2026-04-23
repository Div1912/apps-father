GENRE = Shooter.

- Player aims and fires at enemies. Top-down or first-person depending on `gameDimension`.
- Bullet system: pool bullets (don't allocate per shot). Recommended pool size 64-128. Recycle on offscreen / hit / TTL.
- Enemies: pool similarly. Spawn at the edges of the camera frustum; despawn when far behind the player.
- Hit detection: simple sphere-sphere or AABB tests every frame. Three.js `Raycaster` only for click-to-aim or laser-style weapons (not per-frame bullet sweeps).
- Fire-rate cap: enforce a `lastShotAt` timestamp; ignore inputs faster than `1000 / FIRE_RATE` ms apart.
- Player health: 3 hits is a good default. Show as small heart icons in the score badge area. Game over = 0 health.
- Recoil / muzzle flash / hit flash MUST be present — even one frame of color flip on hit makes the game feel alive.
- Haptic on every shot (`'light'`) and every hit taken (`'medium'`).
