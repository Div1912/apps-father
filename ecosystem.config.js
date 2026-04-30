module.exports = {
  apps: [
    {
      name: "apps-father",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      // ── Memory backstops (in priority order) ──────────────────────────────
      // 1. V8 hard heap cap at 8 GB. Beyond this, V8 aborts itself instead
      //    of letting RSS grow to 22 GB and being SIGKILLed by the kernel
      //    OOM-killer (which leaves no diagnostic output). 8 GB << 23 GB
      //    system RAM so we'll always get a clean abort.
      // 2. heapsnapshot-near-heap-limit=2 — V8 dumps up to 2 .heapsnapshot
      //    files into cwd (/opt/apps-father/) before the abort, which can
      //    be loaded into Chrome DevTools to find the retainer.
      // 3. max_memory_restart bumped 1G → 6G. PM2's RSS poll fires at most
      //    every 30 s and was missing the leak entirely at the old 1G
      //    setting (process was growing 0 → 22 GB faster than the poll
      //    cadence). 6 GB gives PM2 a fair chance to catch it before V8.
      // ────────────────────────────────────────────────────────────────────
      // node_args is unreliable on PM2 fork mode — the flags get saved to
      // PM2 metadata but don't always reach the spawned node process'
      // command line. NODE_OPTIONS is the bulletproof path: V8 reads it
      // at process startup regardless of invocation. Verify after deploy
      // with:  tr '\0' '\n' < /proc/<pid>/environ | grep NODE_OPTIONS
      node_args: [
        "--require=dotenv/config",
      ],
      max_memory_restart: "6G",
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2",
      },
    },
  ],
};
