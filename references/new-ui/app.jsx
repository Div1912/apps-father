// Main app — routes between Home (Apps Father) and Chain (Agent timeline) views

const { useState: useS, useEffect: useE } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "accentHue": 230,
  "speed": 1,
  "compact": false,
  "agentName": "Forge",
  "task": "Build a fitness tracker with social feed",
  "startScreen": "home"
}/*EDITMODE-END*/;

const accentFromHue = (h) => `oklch(0.68 0.19 ${h})`;
const accentSoftFromHue = (h) => `oklch(0.68 0.19 ${h} / 0.16)`;

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
          placeholder="Ask the agent to change something…"
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

function ChainHeader({ accent, agentName, running, onBack, onToggle, appName }) {
  return (
    <div className="app-header">
      <button className="hbtn" onClick={onBack}>
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
          <div className="agent-sub mono">{appName ? `building · ${appName}` : "12 tools · 4 thoughts"}</div>
        </div>
      </div>
      <button className="hbtn" onClick={onToggle}>
        <Icon name="more" size={18} color="rgba(255,255,255,0.85)" />
      </button>
    </div>
  );
}

function ChainScreen({ accent, tweaks, running, setRunning, resetKey, currentApp, onBack, onChat }) {
  const taskText = currentApp ? `Build ${currentApp.name} — ${currentApp.handle || "new app"}` : tweaks.task;
  return (
    <div className="screen" data-screen-label="02 Agent Chain">
      <ChainHeader
        accent={accent}
        agentName={tweaks.agentName}
        running={running}
        onBack={onBack}
        onToggle={() => setRunning((r) => !r)}
        appName={currentApp?.name}
      />
      <div className="task-banner">
        <div className="task-banner-label mono">current task</div>
        <div className="task-banner-text">{taskText}</div>
      </div>
      <div className="chain-wrap">
        <AgentChain
          key={resetKey}
          accent={accent}
          speed={tweaks.speed}
          running={running}
          compact={tweaks.compact}
          timeline={window.AGENT_TIMELINE}
          appName={currentApp?.name || "FitTrack Social"}
          onTest={() => alert("Launching preview…")}
          onChat={onChat}
        />
        <div className="chain-fade" />
      </div>
      <Composer accent={accent} onSend={() => {}} />
    </div>
  );
}

function App() {
  const [tweaks, setTweak] = window.useTweaks(DEFAULTS);
  const [running, setRunning] = useS(true);
  const [resetKey, setResetKey] = useS(0);
  const [view, setView] = useS(tweaks.startScreen || "home");
  const [currentApp, setCurrentApp] = useS(null);

  const accent = accentFromHue(tweaks.accentHue);

  useE(() => {
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-soft", accentSoftFromHue(tweaks.accentHue));
  }, [accent, tweaks.accentHue]);

  const handleReset = () => setResetKey((k) => k + 1);
  const openApp = (app) => {
    setCurrentApp(app);
    setView("chain");
    setResetKey((k) => k + 1);
    setRunning(true);
  };
  const goHome = () => setView("home");
  const goChat = () => setView("chat");

  return (
    <>
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <window.IOSDevice width={390} height={844} dark={true}>
          <div className="route-stack" data-view={view}>
            <div className="route route-home" data-screen-label="01 Home — Apps Father">
              <window.HomeScreen accent={accent} onOpenApp={openApp} />
            </div>
            <div className="route route-chain">
              <ChainScreen
                accent={accent}
                tweaks={tweaks}
                running={running}
                setRunning={setRunning}
                resetKey={resetKey}
                currentApp={currentApp}
                onBack={goHome}
                onChat={goChat}
              />
            </div>
            <div className="route route-chat">
              <window.ChatScreen
                accent={accent}
                agentName={tweaks.agentName}
                onBack={() => setView("chain")}
              />
            </div>
          </div>
        </window.IOSDevice>
      </div>

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection title="Navigate">
          <window.TweakRadio
            label="Screen"
            value={view}
            options={[{ label: "Home", value: "home" }, { label: "Chain", value: "chain" }, { label: "Chat", value: "chat" }]}
            onChange={(v) => setView(v)}
          />
        </window.TweakSection>
        <window.TweakSection title="Look">
          <window.TweakSlider
            label="Accent hue"
            value={tweaks.accentHue}
            min={0} max={360} step={1}
            onChange={(v) => setTweak("accentHue", v)}
          />
          <window.TweakToggle
            label="Compact (hide artifacts)"
            value={tweaks.compact}
            onChange={(v) => setTweak("compact", v)}
          />
        </window.TweakSection>
        <window.TweakSection title="Agent behavior">
          <window.TweakSlider
            label="Speed"
            value={tweaks.speed}
            min={0.25} max={4} step={0.25}
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
        </window.TweakSection>
      </window.TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
