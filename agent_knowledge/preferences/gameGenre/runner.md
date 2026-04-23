GENRE = Runner (endless / lane-based).

- Endless forward motion. Player either auto-moves (Subway Surfers) or hops on input (Crossy Road).
- World is procedurally generated ahead and recycled behind:
  - Maintain a rolling buffer of "chunks" (lanes / road tiles / platforms) extending `STREAMING_AHEAD = 30` units past the camera.
  - Despawn chunks more than `CLEANUP_BEHIND = 15` units behind the camera. Dispose their geometry/materials properly.
  - Pre-warm the buffer at game start so the first frame is not empty.
- Score = distance traveled (in lane units / metres). Display in the top-left score badge.
- Difficulty ramps with score: more obstacles per chunk, faster traffic, narrower safe gaps. Use a single `difficulty = clamp(score / 100, 0, 1)` knob fed into spawn weights.
- Death = collision with obstacle. Game-over overlay shows distance + best.
- Camera follows the player on the forward axis with a small lookahead. Lateral camera shake on death.
- For Crossy-Road-style hop runners specifically: snap player position to a 1-unit grid; queue inputs so a swipe always triggers the next valid hop even mid-animation.
