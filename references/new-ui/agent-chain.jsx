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
    state: i < index ? "done" : i === index ? "running" : "pending"
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
              background: isRunning ? `${accent}22` : "transparent"
            }}>
            
            <div
              className="thought-dot-inner"
              style={{
                background: isRunning ? accent : isDone ? "rgba(255,255,255,0.5)" : pendingColor
              }} />
            
          </div>
        </div>
        <div className="thought-bubble" data-state={state}>
          <div className="thought-label">
            <span style={{ color: isRunning ? accent : "rgba(255,255,255,0.45)" }}>
              {isRunning ? "thinking" : "thought"}
            </span>
            {isRunning && <span className="dots"><i /><i /><i /></span>}
          </div>
          <div className="thought-text">
            {isPending ? <span className="placeholder">…</span> : item.text}
          </div>
        </div>
      </div>);

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
            boxShadow: isRunning ? `0 0 0 6px ${accent}1f, 0 0 24px ${accent}66` : "none"
          }}>
          
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
            {isRunning &&
            <span className="badge running" style={{ borderColor: `${accent}55`, color: accent, background: `${accent}14` }}>
                <span className="pulse" style={{ background: accent }} />
                running
              </span>
            }
            {isDone &&
            <span className="badge done">
                <Icon name="check" size={10} color="rgba(255,255,255,0.55)" />
              </span>
            }
            {isPending && <span className="badge pending">queued</span>}
          </div>
        </div>
        {item.detail && !isPending &&
        <div className="tool-detail mono">{item.detail}</div>
        }
        {item.artifact && !isPending && !compact &&
        <Artifact data={item.artifact} accent={accent} state={state} />
        }
      </div>
    </div>);

}

function Artifact({ data, accent, state }) {
  if (data.type === "tree") {
    return (
      <pre className="artifact tree mono">
        {data.lines.map((l, i) =>
        <div key={i} className="artifact-line" style={{ animationDelay: `${i * 60}ms` }}>
            {l}
          </div>
        )}
      </pre>);

  }
  if (data.type === "code") {
    return (
      <pre className="artifact code mono">
        <div className="artifact-tab">
          <span className="dot" style={{ background: accent }} />
          <span className="lang">{data.lang}</span>
        </div>
        {data.lines.map((l, i) =>
        <div key={i} className="artifact-line" style={{ animationDelay: `${i * 50}ms` }}>
            <span className="ln">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: highlight(l, accent) }} />
          </div>
        )}
      </pre>);

  }
  return null;
}

function highlight(line, accent) {
  // very tiny syntax highlighter
  const kw = ["export", "function", "const", "let", "return", "useState", "useEffect", "import", "from"];
  let out = line.
  replace(/&/g, "&amp;").
  replace(/</g, "&lt;").
  replace(/>/g, "&gt;");
  kw.forEach((k) => {
    out = out.replace(new RegExp(`\\b${k}\\b`, "g"), `<span style="color:${accent}">${k}</span>`);
  });
  out = out.replace(/(\/\/[^\n]*)/g, `<span style="color:rgba(255,255,255,0.35)">$1</span>`);
  out = out.replace(/(['"`])(.*?)\1/g, `<span style="color:#7dd3a0">$1$2$1</span>`);
  return out;
}

function CompletionCard({ accent, onTest, onChat, appName }) {
  return (
    <div className="completion-card">
      <div className="completion-glow" style={{ background: `radial-gradient(closest-side, ${accent}55, transparent 70%)` }} />
      <div className="completion-head">
        <div className="completion-check" style={{ background: accent, borderColor: accent }}>
          <Icon name="check" size={16} color="#000" strokeWidth={3} />
        </div>
        <div className="completion-head-text">
          <div className="completion-title">Build complete</div>
          <div className="completion-sub mono">10 steps · 4.6s · 0 errors</div>
        </div>
        <button className="completion-rate" style={{ borderColor: `${accent}55`, color: accent, background: "transparent" }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
          </svg>
          <span>Rate</span>
          <span className="completion-rate-tag">+3</span>
        </button>
      </div>

      <div className="completion-summary-block">
        <div className="completion-eyebrow mono">Expanded currency list</div>
        <div className="completion-summary">What update would you like to make to your Currency Converter app? Here are some common options to consider:</div>
      </div>

      <div className="completion-action-row">
        <button className="action-primary" style={{ background: accent, color: "#000" }} onClick={onTest}>
          <Icon name="play" size={12} color="#000" />
          <span>Run test</span>
        </button>
        <button className="action-icon" aria-label="View files">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </button>
      </div>

    {/* big rate row removed — using mini Rate button in head */}

      <div className="action-bot">
        <div className="action-bot-text">
          <div className="action-bot-title">Connect Telegram bot</div>
          <div className="action-bot-sub">Create a bot — Apps Father will hook it up automatically.</div>
        </div>
        <button className="action-bot-cta" style={{ background: accent, color: "#000" }}>
          Connect Bot
        </button>
      </div>
    </div>);

}

function AgentChain({ accent, speed, running, compact, timeline, onTest, onChat, appName }) {
  const { items } = useStream(timeline, speed, running);
  const scrollerRef = useRef(null);
  const allDone = items.every((i) => i.state === "done");

  // auto-scroll to running item or to bottom when done
  useEffect(() => {
    if (allDone) {
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
      return;
    }
    const running = scrollerRef.current?.querySelector(".row.running");
    if (running) {
      const top = running.offsetTop - 80;
      scrollerRef.current.scrollTo({ top, behavior: "smooth" });
    }
  }, [items.findIndex((i) => i.state === "running"), allDone]);

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
        {items.map((it, i) =>
        <ToolNode key={it.id} item={it} accent={accent} isLast={i === items.length - 1} compact={compact} />
        )}
        {allDone && <CompletionCard accent={accent} onTest={onTest} onChat={onChat} appName={appName} />}
        <div className="chain-foot" />
      </div>
    </div>);

}

window.AgentChain = AgentChain;