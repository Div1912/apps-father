// Main app — wraps AgentChain inside the iOS frame, adds header + composer.

const { useState: useS, useEffect: useE, useRef: useR } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "accentHue": 230,
  "speed": 1,
  "compact": false,
  "showRail": true,
  "agentName": "Forge",
  "task": "Build a fitness tracker with social feed"
}/*EDITMODE-END*/;

function accentFromHue(h) {
  // electric blue family by default; oklch keeps chroma consistent
  return `oklch(0.68 0.19 ${h})`;
}
function accentSoftFromHue(h) {
  return `oklch(0.68 0.19 ${h} / 0.16)`;
}

function Composer({ accent, onSend }) {
  const [v, setV] = useS("");
  const [focused, setFocused] = useS(false);
  return (
    <div className="composer">
      <div className="composer-quick">
        <button className="chip">
          <Icon name="globe" size={11} color="rgba(255,255,255,0.55)" />
          <span>Research</span>
        </button>
        <button className="chip active" style={{ borderColor: `${accent}55`, color: accent, background: `${accent}14` }}>
          <Icon name="code" size={11} color={accent} />
          <span>Build</span>
        </button>
        <button className="chip">
          <Icon name="sparkle" size={11} color="rgba(255,255,255,0.55)" />
          <span>Design</span>
        </button>
      </div>
      <div className="composer-row" data-focused={focused}>
        <button className="composer-btn">
          <Icon name="plus" size={16} color="rgba(255,255,255,0.6)" />
        </button>
        <input
          className="composer-input"
          placeholder="Ask Forge to change something…"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <button className="composer-btn">
          <Icon name="mic" size={15} color="rgba(255,255,255,0.6)" />
        </button>
        <button
          className="composer-send"
          style={{ background: v ? accent : "rgba(255,255,255,0.08)" }}
          onClick={() => { if (v) { onSend?.(v); setV(""); } }}
        >
          <Icon name={v ? "send" : "stop"} size={14} color={v ? "#000" : "rgba(255,255,255,0.6)"} />
        </button>
      </div>
    </div>
  );
}

function Header({ accent, agentName, running, onToggle }) {
  return (
    <div className="app-header">
      <button className="hbtn">
        <Icon name="back" size={18} color="rgba(255,255,255,0.85)" />
      </button>
      <div className="agent-presence">
        <div className="avatar" style={{ borderColor: `${accent}66` }}>
          <div className="avatar-ring" style={{ background: `conic-gradient(from 0deg, ${accent}, transparent 70%)` }} />
          <div className="avatar-core">
            <Icon name="sparkle" size={12} color={accent} />
          </div>
        </div>
        <div className="agent-meta">
          <div className="agent-name">
            {agentName}
            <span className="agent-status">
              <span className="status-dot" style={{ background: running ? accent : "rgba(255,255,255,0.3)" }} />
              {running ? "working" : "paused"}
            </span>
          </div>
          <div className="agent-sub mono">12 tools · 4 thoughts</div>
        </div>
      </div>
      <button className="hbtn" onClick={onToggle}>
        <Icon name="more" size={18} color="rgba(255,255,255,0.85)" />
      </button>
    </div>
  );
}

function App() {
  const [tweaks, setTweak] = window.useTweaks(DEFAULTS);
  const [running, setRunning] = useS(true);
  const [resetKey, setResetKey] = useS(0);

  const accent = accentFromHue(tweaks.accentHue);

  useE(() => {
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-soft", accentSoftFromHue(tweaks.accentHue));
  }, [accent, tweaks.accentHue]);

  // On reset, force timeline remount
  const handleReset = () => setResetKey((k) => k + 1);

  return (
    <>
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <window.IOSDevice width={390} height={844} dark={true}>
        <div className="screen">
          <Header
            accent={accent}
            agentName={tweaks.agentName}
            running={running}
            onToggle={() => setRunning((r) => !r)}
          />
          <div className="task-banner">
            <div className="task-banner-label mono">current task</div>
            <div className="task-banner-text">{tweaks.task}</div>
          </div>
          <div className="chain-wrap">
            <AgentChain
              key={resetKey}
              accent={accent}
              speed={tweaks.speed}
              running={running}
              compact={tweaks.compact}
              timeline={window.AGENT_TIMELINE}
            />
            <div className="chain-fade" />
          </div>
          <Composer accent={accent} onSend={() => {}} />
        </div>
      </window.IOSDevice>
      </div>

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection title="Look">
          <window.TweakSlider
            label="Accent hue"
            value={tweaks.accentHue}
            min={0}
            max={360}
            step={1}
            onChange={(v) => setTweak("accentHue", v)}
          />
          <window.TweakToggle
            label="Compact (hide artifacts)"
            value={tweaks.compact}
            onChange={(v) => setTweak("compact", v)}
          />
        </window.TweakSection>
        <window.TweakSection title="Behavior">
          <window.TweakSlider
            label="Speed"
            value={tweaks.speed}
            min={0.25}
            max={4}
            step={0.25}
            onChange={(v) => setTweak("speed", v)}
          />
          <window.TweakToggle
            label="Running"
            value={running}
            onChange={(v) => setRunning(v)}
          />
          <window.TweakButton onClick={handleReset}>Restart timeline</window.TweakButton>
        </window.TweakSection>
        <window.TweakSection title="Content">
          <window.TweakText
            label="Agent name"
            value={tweaks.agentName}
            onChange={(v) => setTweak("agentName", v)}
          />
          <window.TweakText
            label="Task"
            value={tweaks.task}
            onChange={(v) => setTweak("task", v)}
          />
        </window.TweakSection>
      </window.TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
