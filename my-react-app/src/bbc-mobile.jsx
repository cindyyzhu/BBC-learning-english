import { useState, useRef, useEffect, useCallback } from "react";

const SECTIONS = [
  {
    id: "office-english",
    label: "Office English",
    icon: "💼",
    itunesId: "1726947236",
    bbcUrl: "https://www.bbc.co.uk/learningenglish/english/features/office-english",
    color: "#1a6b4a",
    light: "#e8f5ef",
  },
  {
    id: "6-minute-english",
    label: "6 Minute English",
    icon: "⏱",
    itunesId: "262026947",
    bbcUrl: "https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2025",
    color: "#b11116",
    light: "#fdf0ee",
  },
  {
    id: "the-english-we-speak",
    label: "The English We Speak",
    icon: "🗣",
    itunesId: "262026989",
    bbcUrl: "https://www.bbc.co.uk/learningenglish/english/features/the-english-we-speak_2024",
    color: "#b35c00",
    light: "#fdf4e7",
  },
  {
    id: "grammar",
    label: "Grammar",
    icon: "📖",
    itunesId: "1080974028",
    bbcUrl: "https://www.bbc.co.uk/learningenglish/english/features/learning-english-grammar",
    color: "#1c5fa5",
    light: "#eaf2fb",
  },
  {
    id: "vocabulary",
    label: "Vocabulary",
    icon: "🗂",
    itunesId: "1036379102",
    bbcUrl: "https://www.bbc.co.uk/learningenglish/english/intermediate-vocabulary",
    color: "#7b3fa0",
    light: "#f5edfb",
  },
];

function extractTranscriptUrl(description) {
  if (!description) return null;
  const m = description.match(/https:\/\/www\.bbc\.co\.uk\/learningenglish\/[^\s"<)]+/);
  return m ? m[0] : null;
}

async function fetchEpisodes(itunesId) {
  const isLocal = window.location.hostname === 'localhost';
  
  let json;
  if (isLocal) {
    // On localhost, call iTunes directly (no CORS issue in dev)
    const res = await fetch(`https://itunes.apple.com/lookup?id=${itunesId}&media=podcast&entity=podcastEpisode&limit=300`);
    if (!res.ok) throw new Error("iTunes API error");
    json = await res.json();
  } else {
    // On Vercel, use our serverless proxy
    const res = await fetch(`/api/itunes?id=${itunesId}`);
    if (!res.ok) throw new Error("iTunes API error");
    json = await res.json();
  }

  return json.results
    .filter(r => r.wrapperType === "podcastEpisode")
    .map(r => ({
      title: r.trackName || "Untitled",
      pubDate: r.releaseDate || "",
      audioUrl: r.episodeUrl || null,
      duration: r.trackTimeMillis ? formatDur(r.trackTimeMillis) : "",
      description: stripHtml(r.description || ""),
      transcriptUrl: extractTranscriptUrl(r.description || ""),
    }));
}

function formatDur(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
}
function formatDate(str) {
  if (!str) return "";
  try { return new Date(str).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return str; }
}

const PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
];

async function fetchTranscriptPage(transcriptUrl) {
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(transcriptUrl)}`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error("Proxy error");
  return res.text();
}

function parseTranscriptHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,nav,header,footer,.navigation,.bbcle-header,.bbcle-footer").forEach(el => el.remove());
  const selectors = [".widget-content-chunks",".bbcle-content-text",".widget-richtext",".richtext",".text-passage",".transcript","article","main"];
  let content = "";
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el && el.textContent.trim().length > 200) {
      el.querySelectorAll("nav,header,footer,.navigation").forEach(n => n.remove());
      content = el.innerHTML; break;
    }
  }
  if (!content) {
    content = Array.from(doc.querySelectorAll("p"))
      .filter(p => p.textContent.trim().length > 20)
      .map(p => `<p>${p.textContent.trim()}</p>`).join("\n");
  }
  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<img[^>]*/gi, "<img style='max-width:100%'")
    .replace(/href="\/([^"]+)"/g, `href="https://www.bbc.co.uk/$1" target="_blank" rel="noopener"`);
  const title = doc.querySelector("h1")?.textContent?.trim() || "";
  const date = doc.querySelector("time,.date")?.textContent?.trim() || "";
  return { title, date, content };
}

// ── Audio Player ──────────────────────────────────────────────────────────────
function AudioPlayer({ audioUrl, title }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [err, setErr] = useState(false);

  useEffect(() => { setPlaying(false); setProgress(0); setCurrentTime(0); setDuration(0); setErr(false); }, [audioUrl]);

  const fmt = s => (!s || isNaN(s)) ? "0:00" : `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;
  const toggle = () => {
    const a = audioRef.current; if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else a.play().then(() => setPlaying(true)).catch(() => setErr(true));
  };
  const seek = e => {
    const a = audioRef.current; if (!a?.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
  };
  const skip = s => { if (audioRef.current) audioRef.current.currentTime += s; };

  return (
    <div style={{ background: "#16213e", borderRadius: 14, padding: "1.25rem", color: "#fff" }}>
      <audio ref={audioRef} src={audioUrl}
        onTimeUpdate={() => { const a = audioRef.current; if (a?.duration) { setCurrentTime(a.currentTime); setProgress(a.currentTime/a.duration*100); }}}
        onLoadedMetadata={() => { if (audioRef.current) setDuration(audioRef.current.duration); }}
        onEnded={() => setPlaying(false)} />
      {err ? (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#f97", fontSize: 13, margin: "0 0 10px", fontFamily: "sans-serif" }}>Playback blocked by browser. Open on BBC to listen.</p>
          <a href={audioUrl} target="_blank" rel="noopener" style={{ color: "#4fc3f7", fontSize: 13, fontFamily: "sans-serif" }}>Try direct link ↗</a>
        </div>
      ) : <>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#8899bb", lineHeight: 1.4, fontFamily: "sans-serif" }}>{title}</p>
        <div onClick={seek} style={{ height: 6, background: "#2a3a5e", borderRadius: 3, cursor: "pointer", marginBottom: 8, position: "relative", touchAction: "none" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: "#4fc3f7", borderRadius: 3 }} />
          <div style={{ position: "absolute", top: "50%", left: `${progress}%`, transform: "translate(-50%,-50%)", width: 16, height: 16, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.4)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#aab", marginBottom: 16, fontFamily: "sans-serif" }}>
          <span>{fmt(currentTime)}</span><span style={{ color: "#556" }}>{fmt(duration)}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 20 }}>
          <button onClick={() => skip(-10)} style={cBtn("#1e2d50", false)}>
            <span style={{ fontSize: 18 }}>⏮</span>
            <span style={{ fontSize: 10, fontFamily: "sans-serif", color: "#8899bb" }}>10s</span>
          </button>
          <button onClick={toggle} style={cBtn("#4fc3f7", true)}>
            <span style={{ fontSize: 24, color: "#16213e", marginLeft: playing ? 0 : 3 }}>{playing ? "⏸" : "▶"}</span>
          </button>
          <button onClick={() => skip(10)} style={cBtn("#1e2d50", false)}>
            <span style={{ fontSize: 18 }}>⏭</span>
            <span style={{ fontSize: 10, fontFamily: "sans-serif", color: "#8899bb" }}>10s</span>
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
          <span style={{ fontSize: 14 }}>🔈</span>
          <input type="range" min={0} max={1} step={0.05} value={volume}
            onChange={e => { setVolume(+e.target.value); if (audioRef.current) audioRef.current.volume = +e.target.value; }}
            style={{ flex: 1, accentColor: "#4fc3f7", height: 4 }} />
          <span style={{ fontSize: 14 }}>🔊</span>
        </div>
      </>}
    </div>
  );
}
function cBtn(bg, big) {
  return { background: bg, border: "none", borderRadius: big ? "50%" : 10, width: big ? 60 : 48, height: big ? 60 : 48, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", flexShrink: 0, boxShadow: big ? "0 4px 16px rgba(79,195,247,0.3)" : "none" };
}

function Spinner({ color = "#b11116" }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2.5rem" }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", border: "3px solid #e8e8e8", borderTopColor: color, animation: "bbcspin .75s linear infinite" }} />
      <style>{`@keyframes bbcspin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ── Episode List Panel (used in both mobile sheet and desktop sidebar) ────────
function EpisodeList({ episodes, loading, error, filtered, search, setSearch, selectedEp, onPick, sec, bbcUrl }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #ece8e2", flexShrink: 0 }}>
        <input type="text" placeholder="Search episodes…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid #ddd", fontSize: 14, fontFamily: "sans-serif", boxSizing: "border-box", outline: "none", background: "#fafaf8" }} />
      </div>
      <div style={{ overflowY: "auto", flex: 1, WebkitOverflowScrolling: "touch" }}>
        {loading && <Spinner color={sec.color} />}
        {error && (
          <div style={{ padding: "1.25rem", fontSize: 14, color: "#b11116", fontFamily: "sans-serif", lineHeight: 1.7 }}>
            {error}<br />
            <a href={bbcUrl} target="_blank" rel="noopener" style={{ color: sec.color }}>Browse on BBC ↗</a>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && <div style={{ padding: "1rem", fontSize: 14, color: "#888", fontFamily: "sans-serif" }}>{search ? "No results." : "No episodes found."}</div>}
        {filtered.map((ep, i) => {
          const active = selectedEp === ep;
          const shortTitle = ep.title.replace(/^(Office English|6 Minute English|The English We Speak|Learning English Grammar|Learning English Vocabulary):\s*/i, "");
          return (
            <button key={i} onClick={() => onPick(ep)} style={{ width: "100%", textAlign: "left", background: active ? sec.light : "transparent", border: "none", padding: "12px 14px", cursor: "pointer", fontFamily: "inherit", borderLeft: `4px solid ${active ? sec.color : "transparent"}`, borderBottom: "1px solid #f0ece6", WebkitTapHighlightColor: "transparent" }}>
              <div style={{ fontSize: 14, fontWeight: active ? 700 : 500, color: "#1a1a1a", lineHeight: 1.4, marginBottom: 4 }}>{shortTitle}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {ep.pubDate && <span style={{ fontSize: 12, color: "#999", fontFamily: "sans-serif" }}>{formatDate(ep.pubDate)}</span>}
                {ep.duration && <span style={{ fontSize: 12, color: "#bbb", fontFamily: "sans-serif" }}>· {ep.duration}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [activeSection, setActiveSection] = useState(SECTIONS[0]);
  const [episodes, setEpisodes] = useState([]);
  const [epsLoading, setEpsLoading] = useState(false);
  const [epsError, setEpsError] = useState(null);

  const [selectedEp, setSelectedEp] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState(null);

  const [search, setSearch] = useState("");

  // Mobile-specific state
  const [mobileView, setMobileView] = useState("list"); // "list" | "episode"
  const [showSectionSheet, setShowSectionSheet] = useState(false);

  useEffect(() => {
    setEpisodes([]); setSelectedEp(null); setTranscript(null);
    setEpsError(null); setEpsLoading(true); setSearch("");
    setMobileView("list");
    fetchEpisodes(activeSection.itunesId)
      .then(setEpisodes)
      .catch(e => setEpsError("Could not load episodes: " + (e.message || "unknown")))
      .finally(() => setEpsLoading(false));
  }, [activeSection]);

  const pickEpisode = useCallback(async ep => {
    setSelectedEp(ep); setTranscript(null); setTxError(null);
    setMobileView("episode");
    if (!ep.transcriptUrl) { setTxError("No transcript link found for this episode."); return; }
    setTxLoading(true);
    try {
      const html = await fetchTranscriptPage(ep.transcriptUrl);
      setTranscript(parseTranscriptHtml(html));
    } catch {
      setTxError("Could not load transcript. Click 'Open on BBC' to read it there.");
    } finally { setTxLoading(false); }
  }, []);

  const sec = activeSection;
  const filtered = search.trim()
    ? episodes.filter(ep => ep.title.toLowerCase().includes(search.toLowerCase()) || ep.description.toLowerCase().includes(search.toLowerCase()))
    : episodes;

  const episodeListPanel = (
    <EpisodeList
      episodes={episodes} loading={epsLoading} error={epsError}
      filtered={filtered} search={search} setSearch={setSearch}
      selectedEp={selectedEp} onPick={ep => { pickEpisode(ep); }}
      sec={sec} bbcUrl={sec.bbcUrl}
    />
  );

  const episodeContent = selectedEp && (
    <>
      {/* Episode header */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: sec.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5, fontFamily: "sans-serif" }}>{sec.label}</div>
            <h1 style={{ margin: "0 0 6px", fontSize: 19, color: "#1a1a1a", fontWeight: 700, lineHeight: 1.35, wordBreak: "break-word" }}>{selectedEp.title}</h1>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {selectedEp.pubDate && <span style={{ fontSize: 12, color: "#888", fontFamily: "sans-serif" }}>📅 {formatDate(selectedEp.pubDate)}</span>}
              {selectedEp.duration && <span style={{ fontSize: 12, color: "#888", fontFamily: "sans-serif" }}>⏱ {selectedEp.duration}</span>}
            </div>
            {selectedEp.description && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#555", lineHeight: 1.6, fontFamily: "sans-serif" }}>{selectedEp.description.slice(0, 200)}{selectedEp.description.length > 200 ? "…" : ""}</p>}
          </div>
          {selectedEp.transcriptUrl && (
            <a href={selectedEp.transcriptUrl} target="_blank" rel="noopener" style={{ background: sec.color, color: "#fff", padding: "8px 14px", borderRadius: 8, textDecoration: "none", fontSize: 12, fontFamily: "sans-serif", flexShrink: 0, whiteSpace: "nowrap" }}>BBC ↗</a>
          )}
        </div>
      </div>

      {/* Audio */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "1.25rem" }}>
        <div style={{ fontSize: 13, color: "#666", fontWeight: 600, fontFamily: "sans-serif", marginBottom: 12 }}>🎧 Audio Player</div>
        {selectedEp.audioUrl
          ? <AudioPlayer audioUrl={selectedEp.audioUrl} title={selectedEp.title} />
          : (
            <div style={{ background: "#f9f6f2", borderRadius: 10, padding: "1.25rem", textAlign: "center", border: "1px dashed #d0c8be" }}>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "#666", lineHeight: 1.6, fontFamily: "sans-serif" }}>Audio must be played on BBC Learning English.</p>
              {selectedEp.transcriptUrl && <a href={selectedEp.transcriptUrl} target="_blank" rel="noopener" style={{ display: "inline-block", background: sec.color, color: "#fff", padding: "9px 18px", borderRadius: 8, textDecoration: "none", fontSize: 13, fontFamily: "sans-serif" }}>Listen on BBC ↗</a>}
            </div>
          )}
      </div>

      {/* Transcript */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "1.25rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 8 }}>
          <div style={{ fontSize: 13, color: "#666", fontWeight: 600, fontFamily: "sans-serif" }}>📄 Transcript</div>
          {txError && <span style={{ fontSize: 12, color: "#b11116", background: "#fdf0ee", padding: "4px 10px", borderRadius: 6, fontFamily: "sans-serif" }}>{txError}</span>}
          {selectedEp.transcriptUrl && !txError && <a href={selectedEp.transcriptUrl} target="_blank" rel="noopener" style={{ fontSize: 12, color: sec.color, fontFamily: "sans-serif", textDecoration: "none", whiteSpace: "nowrap" }}>BBC ↗</a>}
        </div>
        {txLoading && <Spinner color={sec.color} />}
        {!txLoading && transcript && (
          <div>
            {transcript.title && <h3 style={{ fontSize: 16, fontWeight: 700, color: "#1a1a1a", margin: "0 0 4px" }}>{transcript.title}</h3>}
            {transcript.date && <p style={{ fontSize: 12, color: "#999", margin: "0 0 14px", fontFamily: "sans-serif" }}>{transcript.date}</p>}
            <div className="tx-body" style={{ fontSize: 15, lineHeight: 1.9, color: "#222" }} dangerouslySetInnerHTML={{ __html: transcript.content }} />
          </div>
        )}
        {!txLoading && !transcript && !txError && !selectedEp.transcriptUrl && <p style={{ color: "#888", fontFamily: "sans-serif", fontSize: 14 }}>No transcript available.</p>}
      </div>
    </>
  );

  return (
    <div style={{ fontFamily: "Georgia, serif", minHeight: "100vh", background: "#f4f1ec", display: "flex", flexDirection: "column" }}>

      {/* ── Header ── */}
      <header style={{ background: "#b11116", color: "#fff", height: 52, display: "flex", alignItems: "center", gap: 12, padding: "0 1rem", position: "sticky", top: 0, zIndex: 300, boxShadow: "0 2px 8px rgba(0,0,0,0.3)", flexShrink: 0 }}>
        {/* Mobile: back button when viewing episode */}
        <button
          onClick={() => setMobileView("list")}
          style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", padding: "4px 6px 4px 0", display: mobileView === "episode" ? "flex" : "none", alignItems: "center", WebkitTapHighlightColor: "transparent" }}
          className="mobile-only"
        >‹</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ background: "#fff", color: "#b11116", fontWeight: 900, fontSize: 11, padding: "2px 5px", borderRadius: 3, letterSpacing: 0.5, fontFamily: "sans-serif" }}>BBC</div>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Learning English</span>
        </div>
        <div style={{ flex: 1 }} />
        {/* Mobile: section picker button */}
        <button
          onClick={() => setShowSectionSheet(true)}
          className="mobile-only"
          style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", fontSize: 12, padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "sans-serif", WebkitTapHighlightColor: "transparent", display: "none" }}
        >
          {sec.icon} {sec.label.split(" ")[0]} ▾
        </button>
        <a href="https://www.bbc.co.uk/learningenglish/" target="_blank" rel="noopener" className="desktop-only" style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, textDecoration: "none", fontFamily: "sans-serif" }}>BBC ↗</a>
      </header>

      {/* ── Desktop: section tabs ── */}
      <nav className="desktop-only" style={{ background: "#fff", borderBottom: "1px solid #e0dbd4", display: "flex", overflowX: "auto", padding: "0 0.5rem", scrollbarWidth: "none", flexShrink: 0 }}>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s)} style={{ background: "none", border: "none", cursor: "pointer", padding: "13px 16px", fontSize: 13, fontFamily: "inherit", color: activeSection.id === s.id ? s.color : "#666", borderBottom: `3px solid ${activeSection.id === s.id ? s.color : "transparent"}`, fontWeight: activeSection.id === s.id ? 700 : 400, whiteSpace: "nowrap" }}>
            {s.icon} {s.label}
          </button>
        ))}
      </nav>

      {/* ── Mobile: bottom section tabs ── */}
      <nav className="mobile-only" style={{ background: "#fff", borderBottom: "1px solid #e0dbd4", display: "none", overflowX: "auto", flexShrink: 0, scrollbarWidth: "none" }}>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s)} style={{ background: "none", border: "none", cursor: "pointer", padding: "10px 14px", fontSize: 12, fontFamily: "inherit", color: activeSection.id === s.id ? s.color : "#666", borderBottom: `3px solid ${activeSection.id === s.id ? s.color : "transparent"}`, fontWeight: activeSection.id === s.id ? 700 : 400, whiteSpace: "nowrap", WebkitTapHighlightColor: "transparent" }}>
            {s.icon} {s.label.replace("The English We Speak", "English We Speak").replace("6 Minute English", "6 Min")}
          </button>
        ))}
      </nav>

      {/* ── Desktop layout ── */}
      <div className="desktop-only" style={{ flex: 1, display: "flex", maxWidth: 1240, margin: "0 auto", width: "100%", padding: "1.25rem", gap: "1.25rem", alignItems: "flex-start", boxSizing: "border-box" }}>
        {/* Sidebar */}
        <aside style={{ width: 300, flexShrink: 0, background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", overflow: "hidden", display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", position: "sticky", top: 66 }}>
          <div style={{ padding: "10px 12px", background: sec.light, borderBottom: "1px solid #e0dbd4", flexShrink: 0, fontWeight: 700, fontSize: 13, color: sec.color, fontFamily: "sans-serif" }}>
            {epsLoading ? "Loading…" : `${filtered.length} episode${filtered.length !== 1 ? "s" : ""}`}
          </div>
          {episodeListPanel}
        </aside>

        {/* Main */}
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {!selectedEp ? (
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "3rem 2rem", textAlign: "center" }}>
              <div style={{ fontSize: 52, marginBottom: 16 }}>{sec.icon}</div>
              <h2 style={{ margin: "0 0 8px", fontSize: 22, color: "#1a1a1a" }}>{sec.label}</h2>
              <p style={{ color: "#777", fontSize: 15, lineHeight: 1.7, margin: "0 0 1.5rem", fontFamily: "sans-serif", maxWidth: 400, marginLeft: "auto", marginRight: "auto" }}>
                {epsLoading ? "Loading episodes…" : `${episodes.length} episodes loaded. Select one to play audio and read the transcript.`}
              </p>
              <a href={sec.bbcUrl} target="_blank" rel="noopener" style={{ display: "inline-block", background: sec.color, color: "#fff", padding: "10px 22px", borderRadius: 8, textDecoration: "none", fontSize: 14, fontFamily: "sans-serif" }}>Browse on BBC ↗</a>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>{episodeContent}</div>
          )}
        </main>
      </div>

      {/* ── Mobile layout ── */}
      <div className="mobile-only" style={{ flex: 1, display: "none", flexDirection: "column", overflow: "hidden" }}>
        {/* Episode list view */}
        <div style={{ display: mobileView === "list" ? "flex" : "none", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", background: sec.light, borderBottom: "1px solid #e0dbd4", flexShrink: 0, fontWeight: 700, fontSize: 13, color: sec.color, fontFamily: "sans-serif" }}>
            {epsLoading ? "Loading…" : `${filtered.length} episode${filtered.length !== 1 ? "s" : ""}`}
          </div>
          {episodeListPanel}
        </div>

        {/* Episode detail view */}
        <div style={{ display: mobileView === "episode" ? "block" : "none", flex: 1, overflowY: "auto", padding: "1rem", WebkitOverflowScrolling: "touch" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {episodeContent}
          </div>
        </div>
      </div>

      {/* ── Footer (desktop only) ── */}
      <footer className="desktop-only" style={{ background: "#1a1a1a", color: "#777", textAlign: "center", padding: "1rem", fontSize: 12, fontFamily: "sans-serif" }}>
        Content © <a href="https://www.bbc.co.uk/learningenglish/" target="_blank" rel="noopener" style={{ color: "#b11116" }}>BBC Learning English</a>. Episodes loaded live via iTunes API.
      </footer>

      <style>{`
        @media (max-width: 700px) {
          .mobile-only { display: flex !important; }
          .desktop-only { display: none !important; }
        }
        @media (min-width: 701px) {
          .mobile-only { display: none !important; }
          .desktop-only { display: flex !important; }
        }
        /* Override flex for nav */
        @media (max-width: 700px) {
          nav.mobile-only { display: flex !important; }
          div.mobile-only { display: flex !important; }
        }
        nav::-webkit-scrollbar { display: none; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
        .tx-body p { margin: 0 0 1rem; }
        .tx-body h2, .tx-body h3 { font-size: 16px; margin: 1.5rem 0 .5rem; color: #333; }
        .tx-body strong, .tx-body b { font-weight: 700; color: #111; }
        .tx-body a { color: #b11116; text-decoration: none; }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>
    </div>
  );
}