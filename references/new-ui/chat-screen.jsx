// Chat screen — conversational Q&A with the agent (not a task chain)
// Demonstrates how the agent answers questions: text, code blocks, suggestions, follow-ups.

const { useState: chUseState, useEffect: chUseEffect, useRef: chUseRef } = React;

const CHAT_HISTORY = [
  {
    id: 1,
    role: "user",
    text: "Why did you choose Skia for the progress ring instead of just SVG?",
  },
  {
    id: 2,
    role: "agent",
    parts: [
      {
        type: "thought",
        text: "Good question — the user wants to understand a technical decision. Let me explain the tradeoff plainly.",
      },
      {
        type: "text",
        text: "Three reasons, in order of impact:",
      },
      {
        type: "list",
        items: [
          { strong: "Gradient strokes.", rest: " SVG can't smoothly interpolate a stroke along a path. Skia handles it natively." },
          { strong: "60fps animation.", rest: " The ring tweens daily progress on every workout. SVG repaints get janky on lower-end Androids." },
          { strong: "Future-proof.", rest: " You'll want shadows, blur, and shaders later — Skia gives you all of that without leaving the rendering pipeline." },
        ],
      },
      {
        type: "code",
        lang: "tsx",
        lines: [
          "<Canvas style={{ width: 220, height: 220 }}>",
          "  <Circle cx={110} cy={110} r={96}>",
          "    <SweepGradient",
          "      c={vec(110, 110)}",
          "      colors={['#3B82F6', '#06B6D4']}",
          "    />",
          "  </Circle>",
          "</Canvas>",
        ],
      },
      {
        type: "text",
        text: "If bundle size is a concern, I can fall back to react-native-svg + a clever stroke-dasharray trick. Want me to swap it?",
      },
      {
        type: "suggestions",
        items: [
          "Stick with Skia",
          "Show me the SVG fallback",
          "What's the bundle cost?",
        ],
      },
    ],
  },
];

function ChatBubbleUser({ text }) {
  return (
    <div className="bubble-row user">
      <div className="bubble user">{text}</div>
    </div>
  );
}

function ChatThought({ text }) {
  return (
    <div className="chat-thought">
      <div className="chat-thought-icon">
        <Icon name="sparkle" size={10} color="rgba(255,255,255,0.5)" />
      </div>
      <div className="chat-thought-body">
        <div className="chat-thought-label mono">reasoning</div>
        <div className="chat-thought-text">{text}</div>
      </div>
    </div>
  );
}

function ChatTextPart({ text }) {
  return <div className="chat-text">{text}</div>;
}

function ChatList({ items }) {
  return (
    <ol className="chat-list">
      {items.map((it, i) => (
        <li key={i}>
          <span className="chat-list-num">{i + 1}</span>
          <span><strong>{it.strong}</strong>{it.rest}</span>
        </li>
      ))}
    </ol>
  );
}

function ChatCode({ lang, lines, accent }) {
  return (
    <div className="chat-code mono">
      <div className="chat-code-head">
        <span className="dot" style={{ background: accent }} />
        <span className="lang">{lang}</span>
        <button className="copy-btn">copy</button>
      </div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className="chat-code-line">
            <span className="ln">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: highlight(l, accent) }} />
          </div>
        ))}
      </pre>
    </div>
  );
}

function ChatSuggestions({ items, accent, onPick }) {
  return (
    <div className="chat-suggestions">
      {items.map((s, i) => (
        <button
          key={i}
          className="suggestion-chip"
          style={{ borderColor: `${accent}33`, color: accent }}
          onClick={() => onPick?.(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function AgentMessage({ parts, accent, streaming, onPick }) {
  // streaming reveals parts one-by-one
  const [revealed, setRevealed] = chUseState(streaming ? 0 : parts.length);
  chUseEffect(() => {
    if (!streaming || revealed >= parts.length) return;
    const t = setTimeout(() => setRevealed((r) => r + 1), 700);
    return () => clearTimeout(t);
  }, [revealed, streaming, parts.length]);

  return (
    <div className="bubble-row agent">
      <div className="agent-mark" style={{ borderColor: `${accent}55`, background: `${accent}14` }}>
        <Icon name="sparkle" size={11} color={accent} />
      </div>
      <div className="agent-stack">
        {parts.slice(0, revealed).map((p, i) => {
          if (p.type === "thought") return <ChatThought key={i} text={p.text} />;
          if (p.type === "text") return <ChatTextPart key={i} text={p.text} />;
          if (p.type === "list") return <ChatList key={i} items={p.items} />;
          if (p.type === "code") return <ChatCode key={i} lang={p.lang} lines={p.lines} accent={accent} />;
          if (p.type === "suggestions") return <ChatSuggestions key={i} items={p.items} accent={accent} onPick={onPick} />;
          return null;
        })}
        {revealed < parts.length && (
          <div className="agent-typing">
            <span className="dots"><i/><i/><i/></span>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatScreen({ accent, agentName, onBack }) {
  const scrollRef = chUseRef(null);
  const [streamKey, setStreamKey] = chUseState(0);

  chUseEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamKey]);

  return (
    <div className="screen chat-screen" data-screen-label="03 Chat">
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
                <span className="status-dot" style={{ background: accent }} />
                online
              </span>
            </div>
            <div className="agent-sub mono">FitTrack Social · q&amp;a</div>
          </div>
        </div>
        <button className="hbtn">
          <Icon name="more" size={18} color="rgba(255,255,255,0.85)" />
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-context">
          <span className="mono">context</span>
          <span>thread on home screen design · 4 messages</span>
        </div>
        {CHAT_HISTORY.map((msg) =>
          msg.role === "user" ? (
            <ChatBubbleUser key={msg.id} text={msg.text} />
          ) : (
            <AgentMessage
              key={`${msg.id}-${streamKey}`}
              parts={msg.parts}
              accent={accent}
              streaming={true}
            />
          )
        )}
        <div style={{ height: 8 }} />
      </div>

      <div className="chain-fade" />
      <Composer accent={accent} onSend={() => setStreamKey((k) => k + 1)} />
    </div>
  );
}

window.ChatScreen = ChatScreen;
