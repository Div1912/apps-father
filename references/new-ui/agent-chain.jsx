// AgentChain — vertical timeline of tool calls + reasoning bubbles
// Streams in over time to feel like the agent is actively working.

const { useState, useEffect, useRef, useMemo } = React;

function useStream(timeline, speed, running) {
  // Returns { items: [...], cursorState, currentIndex }
  // Each item gets a "state": "pending" | "running" | "done"
  const [index, setIndex] = useState(0);
  const [tick, setTick] = useState(0); // forces re-render for "running" pulse

  useEffect(() => {
    if (!running) return;
    if (index >= timeline.length) return;
    const item = timeline[index];
    const dur = (item.duration || 1500) / speed;
    const t = setTimeout(() => setIndex((i) => i + 1), dur);
    return () => clearTimeout(t);
  }, [index, running, speed, timeline]);

  // gentle re-render for the pulse dot
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 600);
    return () => clearInterval(id);
  }, []);

  const items = timeline.map((it, i) => ({
    ...it,
    state: i < index ? "done" : i === index ? "running" : "pending",
  }));

  return { items, currentIndex: index, reset: () => setIndex(0), tick };
}

function ToolNode({ item, accent, isLast, compact }) {
  const isThought = item.kind === "thought";
  const state = item.state;
  const isRunning = state === "running";
  const isDone = state === "done";
  const isPending = state === "pending";

  const pendingColor = "rgba(255,255,255,0.18)";
  const dotBg = isRunning ? accent : isDone ? "rgba(255,255,255,0.06)" : "transparent";
  const dotBorder = isRunning ? accent : isDone ? "rgba(255,255,255,0.18)" : pendingColor;
  const dotIconColor = isRunning ? "#000" : isDone ? "rgba(255,255,255,0.7)" : pendingColor;

  if (isThought) {
    return (
      <div className={`row thought ${state}`}>
        <div className="rail">
          <div className="rail-line" />
          <div
            className="thought-dot"
            style={{
              borderColor: isRunning ? accent : "rgba(255,255,255,0.22)",
              background: isRunning ? `${accent}22` : "transparent",
            }}
          >
            <div
              className="thought-dot-inner"
              style={{
                background: isRunning ? accent : isDone ? "rgba(255,255,255,0.5)" : pendingColor,
              }}
            />
          </div>
        </div>
        <div className="thought-bubble" data-state={state}>
          <div className="thought-label">
            <span style={{ color: isRunning ? accent : "rgba(255,255,255,0.45)" }}>
              {isRunning ? "thinking" : "thought"}
            </span>
            {isRunning && <span className="dots"><i/><i/><i/></span>}
          </div>
          <div className="thought-text">
            {isPending ? <span className="placeholder">…</span> : item.text}
          </div>
        </div>
      </div>
    );
  }

  // tool node
  return (
    <div className={`row tool ${state}`}>
      <div className="rail">
        <div className="rail-line" />
        <div
          className="tool-dot"
          style={{
            background: dotBg,
            borderColor: dotBorder,
            boxShadow: isRunning ? `0 0 0 6px ${accent}1f, 0 0 24px ${accent}66` : "none",
          }}
        >
          <Icon name={item.icon} size={12} color={dotIconColor} />
        </div>
      </div>
      <div className="tool-card" data-state={state}>
        <div className="tool-head">
          <div className="tool-meta">
            <span className="tool-name" style={{ color: isPending ? "rgba(255,255,255,0.3)" : "#fff" }}>
              {item.title}
            </span>
            <span className="tool-sub mono">{item.subtitle}</span>
          </div>
          <div className="tool-status">
            {isRunning && (
              <span className="badge running" style={{ borderColor: `${accent}55`, color: accent, background: `${accent}14` }}>
                <span className="pulse" style={{ background: accent }} />
                running
              </span>
            )}
            {isDone && (
              <span className="badge done">
                <Icon name="check" size={10} color="rgba(255,255,255,0.55)" />
              </span>
            )}
            {isPending && <span className="badge pending">queued</span>}
          </div>
        </div>
        {item.detail && !isPending && (
          <div className="tool-detail mono">{item.detail}</div>
        )}
        {item.artifact && !isPending && !compact && (
          <Artifact data={item.artifact} accent={accent} state={state} />
        )}
      </div>
    </div>
  );
}

function Artifact({ data, accent, state }) {
  if (data.type === "tree") {
    return (
      <pre className="artifact tree mono">
        {data.lines.map((l, i) => (
          <div key={i} className="artifact-line" style={{ animationDelay: `${i * 60}ms` }}>
            {l}
          </div>
        ))}
      </pre>
    );
  }
  if (data.type === "code") {
    return (
      <pre className="artifact code mono">
        <div className="artifact-tab">
          <span className="dot" style={{ background: accent }} />
          <span className="lang">{data.lang}</span>
        </div>
        {data.lines.map((l, i) => (
          <div key={i} className="artifact-line" style={{ animationDelay: `${i * 50}ms` }}>
            <span className="ln">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: highlight(l, accent) }} />
          </div>
        ))}
      </pre>
    );
  }
  return null;
}

function highlight(line, accent) {
  // very tiny syntax highlighter
  const kw = ["export", "function", "const", "let", "return", "useState", "useEffect", "import", "from"];
  let out = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  kw.forEach((k) => {
    out = out.replace(new RegExp(`\\b${k}\\b`, "g"), `<span style="color:${accent}">${k}</span>`);
  });
  out = out.replace(/(\/\/[^\n]*)/g, `<span style="color:rgba(255,255,255,0.35)">$1</span>`);
  out = out.replace(/(['"`])(.*?)\1/g, `<span style="color:#7dd3a0">$1$2$1</span>`);
  return out;
}

function AgentChain({ accent, speed, running, compact, timeline }) {
  const { items } = useStream(timeline, speed, running);
  const scrollerRef = useRef(null);

  // auto-scroll to running item
  useEffect(() => {
    const running = scrollerRef.current?.querySelector(".row.running");
    if (running) {
      const top = running.offsetTop - 80;
      scrollerRef.current.scrollTo({ top, behavior: "smooth" });
    }
  }, [items.findIndex((i) => i.state === "running")]);

  return (
    <div className="chain-scroller" ref={scrollerRef}>
      <div className="chain-header">
        <div className="chain-title">
          <div className="chain-icon" style={{ background: `${accent}1a`, borderColor: `${accent}44` }}>
            <Icon name="sparkle" size={14} color={accent} />
          </div>
          <div>
            <div className="chain-task">Building <span style={{ color: accent }}>FitTrack Social</span></div>
            <div className="chain-subtask mono">task · agt_{Math.random().toString(36).slice(2, 7)}</div>
          </div>
        </div>
        <div className="chain-step mono">
          step {Math.min(items.filter((i) => i.state !== "pending").length, items.length)}/{items.length}
        </div>
      </div>
      <div className="chain">
        {items.map((it, i) => (
          <ToolNode key={it.id} item={it} accent={accent} isLast={i === items.length - 1} compact={compact} />
        ))}
        <div className="chain-foot" />
      </div>
    </div>
  );
}

window.AgentChain = AgentChain;
