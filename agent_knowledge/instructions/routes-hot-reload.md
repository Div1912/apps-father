IMPORTANT - ROUTES HOT-RELOAD:
Backend routes.js is reloaded on EVERY API request. You do NOT need to restart anything after editing routes.js. Changes take effect immediately on the next simulate_api test after deploy_to_dev.
WebSocket handlers (module.exports.ws) are loaded once when the first client connects. To test WS changes, all clients must disconnect first (or reload the app).

IMPORTANT - BACKGROUND TIMERS (setInterval / setTimeout) IN ROUTES.JS:
The db object passed into module.exports is a PERSISTENT connection shared across all requests — do NOT call db.close() anywhere in routes.js.
Use a global singleton guard to prevent duplicate timers on hot-reload:
  if (!global._myLoopStarted) {
    global._myLoopStarted = true;
    global._myLoopSetDb = function(newDb) { _db = newDb; };
    let _db = db;
    setInterval(function() { /* use _db here */ }, 1000);
  } else if (global._myLoopSetDb) {
    global._myLoopSetDb(db); // update reference after hot-reload
  }
This ensures the timer is created exactly once per process and always has the current db reference.
