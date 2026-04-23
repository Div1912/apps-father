CONTROLS = Tilt.

- Use `window.addEventListener('deviceorientation', …)`. On iOS 13+, request permission first inside a user gesture:
  ```js
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    startBtn.addEventListener('click', async () => {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r === 'granted') startGame();
    });
  } else { startGame(); }
  ```
  The Start overlay MUST exist precisely so this permission prompt has a user-gesture context.
- Read `event.gamma` (left-right tilt, ~-90..90) and `event.beta` (forward-back, ~-180..180). Normalise: `steerX = clamp(gamma / MAX_TILT_DEGREES, -1, 1)`. `MAX_TILT_DEGREES = 25` is a comfortable default.
- Apply a dead-zone: `if (Math.abs(steerX) < 0.05) steerX = 0;` to stop drift on a still phone.
- Smooth via low-pass filter: `steerXSmooth += (steerX - steerXSmooth) * 0.15` per frame.
- Calibrate at game start: capture initial gamma as the zero point. Add a "Recalibrate" button on the pause overlay.
- Always pair tilt with a tap-to-act button (jump, fire, etc.). Tilt alone steers; tap alone acts.
- Keyboard fallback: arrow left/right = tilt, space = act.
