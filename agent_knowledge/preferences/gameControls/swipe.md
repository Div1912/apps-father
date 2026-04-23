CONTROLS = Swipe.

- Detect swipes from `pointerdown` → `pointerup` deltas. Threshold: `MIN_SWIPE_DISTANCE = 30` pixels. Anything shorter is treated as a tap.
- Dominant axis wins: if `|dx| > |dy|` → horizontal swipe, else vertical. Map to four intents: `up`, `down`, `left`, `right`.
- Queue inputs: if a swipe arrives while the player is mid-animation (e.g. mid-hop in Crossy Road), queue ONE next intent. Reject further inputs until the queue empties to prevent input mashing.
- Tap (no swipe, just `pointerup` near origin) maps to a forward / "primary" action — e.g. hop forward in a runner.
- Set `touch-action: none` on the canvas. Always `preventDefault` on `pointerdown` to prevent text-selection long-press.
- Keyboard fallback: arrow keys + space (= tap) for desktop testing. Same queue rules.
