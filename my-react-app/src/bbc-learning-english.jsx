import { useState, useRef, useEffect, useCallback } from "react";

// Apple Podcast IDs for each BBC Learning English series
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

// Extract the first BBC learningenglish URL from an episode description
function extractTranscriptUrl(description) {
  if (!description) return null;
  const m = description.match(/https:\/\/www\.bbc\.co\.uk\/learningenglish\/[^\s"<)]+/);
  return m ? m[0] : null;
}

// Fetch all episodes for a podcast from the iTunes Search API (no CORS issues)
async function fetchEpisodes(itunesId) {
  const url = `https://itunes.apple.com/lookup?id=${itunesId}&media=podcast&entity=podcastEpisode&limit=300`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("iTunes API error");
  const json = await res.json();
  // First result is the podcast itself, rest are episodes
  return json.results
    .filter(r => r.wrapperType === "podcastEpisode")
    .map(r => ({
      title: r.trackName || "Untitled",
      pubDate: r.releaseDate || "",
      audioUrl: r.episodeUrl || null,
      duration: r.trackTimeMillis ? formatDuration(r.trackTimeMillis) : "",
      description: stripHtml(r.description || ""),
      transcriptUrl: extractTranscriptUrl(r.description || ""),
    }));
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function formatDate(str) {
  if (!str) return "";
  try {
    return new Date(str).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch { return str; }
}

// Fetch and parse a BBC transcript page via allorigins proxy
// Uses multiple proxy fallbacks
const PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

async function fetchTranscriptPage(transcriptUrl) {
  let lastErr;
  for (const makeUrl of PROXIES) {
    try {
      const res = await fetch(makeUrl(transcriptUrl), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      // allorigins wraps in JSON
      let html = text;
      try { const j = JSON.parse(text); if (j.contents) html = j.contents; } catch {}
      if (html.length > 500) return html;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All proxies failed");
}

function parseTranscriptHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,nav,header,footer,.navigation,.bbcle-header,.bbcle-footer,[class*='nav'],[id*='nav']").forEach(el => el.remove());

  const selectors = [
    ".widget-content-chunks",
    ".bbcle-content-text",
    ".widget-richtext",
    ".richtext",
    ".text-passage",
    ".transcript",
    "article",
    "main",
  ];
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

  // Sanitize
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

  const fmt = s => !s || isNaN(s) ? "0:00" : `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

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
    <div style={{ background: "#16213e", borderRadius: 14, padding: "1.25rem 1.5rem", color: "#fff" }}>
      <audio ref={audioRef} src={audioUrl}
        onTimeUpdate={() => { const a = audioRef.current; if (a?.duration) { setCurrentTime(a.currentTime); setProgress(a.currentTime/a.duration*100); }}}
        onLoadedMetadata={() => { if (audioRef.current) setDuration(audioRef.current.duration); }}
        onEnded={() => setPlaying(false)} />

      {err ? (
        <div style={{ textAlign: "center", padding: "0.5rem" }}>
          <p style={{ color: "#f97", fontSize: 13, margin: "0 0 10px", fontFamily: "sans-serif" }}>Playback blocked by browser (CORS). Open on BBC to listen.</p>
          <a href={audioUrl} target="_blank" rel="noopener" style={{ color: "#4fc3f7", fontSize: 13, fontFamily: "sans-serif" }}>Try direct link ↗</a>
        </div>
      ) : (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "#8899bb", lineHeight: 1.4, fontFamily: "sans-serif" }}>{title}</p>
          <div onClick={seek} style={{ height: 5, background: "#2a3a5e", borderRadius: 3, cursor: "pointer", marginBottom: 8, position: "relative" }}>
            <div style={{ width: `${progress}%`, height: "100%", background: "#4fc3f7", borderRadius: 3 }} />
            <div style={{ position: "absolute", top: "50%", left: `${progress}%`, transform: "translate(-50%,-50%)", width: 13, height: 13, borderRadius: "50%", background: "#fff" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aab", marginBottom: 14, fontFamily: "sans-serif" }}>
            <span>{fmt(currentTime)}</span><span style={{ color: "#556" }}>{fmt(duration)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
            <button onClick={() => skip(-10)} style={cBtn("#1e2d50", false)}>
              <div style={{ fontSize: 16 }}>⏮</div>
              <div style={{ fontSize: 9, fontFamily: "sans-serif", color: "#8899bb" }}>10s</div>
            </button>
            <button onClick={toggle} style={cBtn("#4fc3f7", true)}>
              <span style={{ fontSize: 22, color: "#16213e", marginLeft: playing ? 0 : 2 }}>{playing ? "⏸" : "▶"}</span>
            </button>
            <button onClick={() => skip(10)} style={cBtn("#1e2d50", false)}>
              <div style={{ fontSize: 16 }}>⏭</div>
              <div style={{ fontSize: 9, fontFamily: "sans-serif", color: "#8899bb" }}>10s</div>
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
            <span style={{ fontSize: 13 }}>🔈</span>
            <input type="range" min={0} max={1} step={0.05} value={volume}
              onChange={e => { setVolume(+e.target.value); if (audioRef.current) audioRef.current.volume = +e.target.value; }}
              style={{ flex: 1, accentColor: "#4fc3f7" }} />
            <span style={{ fontSize: 13 }}>🔊</span>
          </div>
        </>
      )}
    </div>
  );
}
function cBtn(bg, big) {
  return { background: bg, border: "none", borderRadius: big ? "50%" : 10, width: big ? 56 : 44, height: big ? 56 : 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", flexShrink: 0, boxShadow: big ? "0 4px 16px rgba(79,195,247,0.3)" : "none" };
}

function Spinner({ color = "#b11116" }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}>
      <div style={{ width: 26, height: 26, borderRadius: "50%", border: `3px solid #e8e8e8`, borderTopColor: color, animation: "bbcspin .75s linear infinite" }} />
      <style>{`@keyframes bbcspin{to{transform:rotate(360deg)}}`}</style>
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
  const [collapsed, setCollapsed] = useState(false);

  // Load episodes via iTunes API when section changes
  useEffect(() => {
    setEpisodes([]); setSelectedEp(null); setTranscript(null);
    setEpsError(null); setEpsLoading(true); setSearch("");
    fetchEpisodes(activeSection.itunesId)
      .then(setEpisodes)
      .catch(e => setEpsError("Could not load episodes: " + (e.message || "unknown error")))
      .finally(() => setEpsLoading(false));
  }, [activeSection]);

  // Load transcript when episode selected
  const pickEpisode = useCallback(async ep => {
    setSelectedEp(ep); setTranscript(null); setTxError(null);
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

  return (
    <div style={{ fontFamily: "Georgia, serif", minHeight: "100vh", background: "#f4f1ec", display: "flex", flexDirection: "column" }}>

      {/* ── Header ── */}
      <header style={{ background: "#b11116", color: "#fff", height: 54, display: "flex", alignItems: "center", gap: 14, padding: "0 1.5rem", position: "sticky", top: 0, zIndex: 200, boxShadow: "0 2px 10px rgba(0,0,0,0.3)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ background: "#fff", color: "#b11116", fontWeight: 900, fontSize: 12, padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5, fontFamily: "sans-serif" }}>BBC</div>
          <span style={{ fontWeight: 700, fontSize: 17 }}>Learning English</span>
        </div>
        <div style={{ flex: 1 }} />
        <a href="https://www.bbc.co.uk/learningenglish/" target="_blank" rel="noopener" style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, textDecoration: "none", fontFamily: "sans-serif" }}>BBC Website ↗</a>
      </header>

      {/* ── Section tabs ── */}
      <nav style={{ background: "#fff", borderBottom: "1px solid #e0dbd4", display: "flex", overflowX: "auto", padding: "0 0.5rem", scrollbarWidth: "none", flexShrink: 0 }}>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s)} style={{ background: "none", border: "none", cursor: "pointer", padding: "13px 16px", fontSize: 13, fontFamily: "inherit", color: activeSection.id === s.id ? s.color : "#666", borderBottom: `3px solid ${activeSection.id === s.id ? s.color : "transparent"}`, fontWeight: activeSection.id === s.id ? 700 : 400, whiteSpace: "nowrap", transition: "color 0.15s" }}>
            {s.icon} {s.label}
          </button>
        ))}
      </nav>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", maxWidth: 1240, margin: "0 auto", width: "100%", padding: "1.25rem", gap: "1.25rem", alignItems: "flex-start", boxSizing: "border-box" }}>

        {/* ── Sidebar ── */}
        <aside style={{ width: collapsed ? 44 : 300, flexShrink: 0, background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", overflow: "hidden", transition: "width 0.2s", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 110px)", position: "sticky", top: 66 }}>
          {/* Sidebar top bar */}
          <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", background: sec.light, borderBottom: "1px solid #e0dbd4", flexShrink: 0 }}>
            {!collapsed && <span style={{ flex: 1, fontWeight: 700, fontSize: 13, color: sec.color, fontFamily: "sans-serif" }}>{epsLoading ? "Loading…" : `${filtered.length} episode${filtered.length !== 1 ? "s" : ""}`}</span>}
            <button onClick={() => setCollapsed(!collapsed)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: sec.color, padding: 2, marginLeft: "auto" }}>{collapsed ? "▶" : "◀"}</button>
          </div>

          {!collapsed && <>
            {/* Search */}
            <div style={{ padding: "8px 10px", borderBottom: "1px solid #ece8e2", flexShrink: 0 }}>
              <input type="text" placeholder="Search episodes…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid #ddd", fontSize: 13, fontFamily: "sans-serif", boxSizing: "border-box", outline: "none", background: "#fafaf8" }} />
            </div>

            {/* List */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {epsLoading && <Spinner color={sec.color} />}
              {epsError && (
                <div style={{ padding: "1rem", fontSize: 13, color: "#b11116", fontFamily: "sans-serif", lineHeight: 1.6 }}>
                  {epsError}<br />
                  <a href={sec.bbcUrl} target="_blank" rel="noopener" style={{ color: sec.color }}>Browse on BBC ↗</a>
                </div>
              )}
              {!epsLoading && !epsError && filtered.length === 0 && <div style={{ padding: "1rem", fontSize: 13, color: "#888", fontFamily: "sans-serif" }}>No episodes found.</div>}
              {filtered.map((ep, i) => {
                const active = selectedEp === ep;
                // Strip series prefix from title for cleaner display
                const shortTitle = ep.title.replace(/^(Office English|6 Minute English|The English We Speak|Learning English Grammar|Learning English Vocabulary):\s*/i, "");
                return (
                  <button key={i} onClick={() => pickEpisode(ep)} style={{ width: "100%", textAlign: "left", background: active ? sec.light : "transparent", border: "none", padding: "10px 14px", cursor: "pointer", fontFamily: "inherit", borderLeft: `4px solid ${active ? sec.color : "transparent"}`, borderBottom: "1px solid #f0ece6", transition: "background 0.12s" }}>
                    <div style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: "#1a1a1a", lineHeight: 1.4, marginBottom: 3 }}>{shortTitle}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {ep.pubDate && <span style={{ fontSize: 11, color: "#999", fontFamily: "sans-serif" }}>{formatDate(ep.pubDate)}</span>}
                      {ep.duration && <span style={{ fontSize: 11, color: "#bbb", fontFamily: "sans-serif" }}>· {ep.duration}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </>}
        </aside>

        {/* ── Main content ── */}
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {!selectedEp ? (
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "3rem 2rem", textAlign: "center" }}>
              <div style={{ fontSize: 52, marginBottom: 16 }}>{sec.icon}</div>
              <h2 style={{ margin: "0 0 8px", fontSize: 22, color: "#1a1a1a" }}>{sec.label}</h2>
              <p style={{ color: "#777", fontSize: 15, lineHeight: 1.7, margin: "0 0 1.5rem", fontFamily: "sans-serif", maxWidth: 400, marginLeft: "auto", marginRight: "auto" }}>
                {epsLoading ? "Loading episodes…" : episodes.length > 0 ? `${episodes.length} episodes loaded. Select one to play and read the transcript.` : "Select a section to browse episodes."}
              </p>
              <a href={sec.bbcUrl} target="_blank" rel="noopener" style={{ display: "inline-block", background: sec.color, color: "#fff", padding: "10px 22px", borderRadius: 8, textDecoration: "none", fontSize: 14, fontFamily: "sans-serif" }}>Browse on BBC ↗</a>
            </div>
          ) : <>
            {/* Episode header */}
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "1.25rem 1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: sec.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "sans-serif" }}>{sec.label}</div>
                  <h1 style={{ margin: "0 0 6px", fontSize: 21, color: "#1a1a1a", fontWeight: 700, lineHeight: 1.35 }}>{selectedEp.title}</h1>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {selectedEp.pubDate && <span style={{ fontSize: 13, color: "#888", fontFamily: "sans-serif" }}>📅 {formatDate(selectedEp.pubDate)}</span>}
                    {selectedEp.duration && <span style={{ fontSize: 13, color: "#888", fontFamily: "sans-serif" }}>⏱ {selectedEp.duration}</span>}
                  </div>
                  {selectedEp.description && <p style={{ margin: "8px 0 0", fontSize: 14, color: "#555", lineHeight: 1.6, fontFamily: "sans-serif" }}>{selectedEp.description.slice(0, 220)}{selectedEp.description.length > 220 ? "…" : ""}</p>}
                </div>
                {selectedEp.transcriptUrl && (
                  <a href={selectedEp.transcriptUrl} target="_blank" rel="noopener" style={{ background: sec.color, color: "#fff", padding: "9px 16px", borderRadius: 8, textDecoration: "none", fontSize: 13, fontFamily: "sans-serif", flexShrink: 0 }}>Open on BBC ↗</a>
                )}
              </div>
            </div>

            {/* Audio */}
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "1.25rem 1.5rem" }}>
              <h2 style={{ margin: "0 0 14px", fontSize: 14, color: "#666", fontWeight: 600, fontFamily: "sans-serif" }}>🎧 Audio Player</h2>
              {selectedEp.audioUrl
                ? <AudioPlayer audioUrl={selectedEp.audioUrl} title={selectedEp.title} />
                : (
                  <div style={{ background: "#f9f6f2", borderRadius: 10, padding: "1.5rem", textAlign: "center", border: "1px dashed #d0c8be" }}>
                    <p style={{ margin: "0 0 12px", fontSize: 14, color: "#666", lineHeight: 1.6, fontFamily: "sans-serif" }}>Audio for this episode must be played on BBC Learning English.</p>
                    {selectedEp.transcriptUrl && <a href={selectedEp.transcriptUrl} target="_blank" rel="noopener" style={{ display: "inline-block", background: sec.color, color: "#fff", padding: "10px 20px", borderRadius: 8, textDecoration: "none", fontSize: 14, fontFamily: "sans-serif" }}>Listen on BBC ↗</a>}
                  </div>
                )}
            </div>

            {/* Transcript */}
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e0dbd4", padding: "1.25rem 1.5rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem", flexWrap: "wrap", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 14, color: "#666", fontWeight: 600, fontFamily: "sans-serif" }}>📄 Transcript</h2>
                {txError && <span style={{ fontSize: 12, color: "#b11116", background: "#fdf0ee", padding: "4px 10px", borderRadius: 6, fontFamily: "sans-serif" }}>{txError}</span>}
                {selectedEp.transcriptUrl && !txError && <a href={selectedEp.transcriptUrl} target="_blank" rel="noopener" style={{ fontSize: 12, color: sec.color, fontFamily: "sans-serif", textDecoration: "none" }}>View on BBC ↗</a>}
              </div>
              {txLoading && <Spinner color={sec.color} />}
              {!txLoading && transcript && (
                <div style={{ maxHeight: 600, overflowY: "auto", paddingRight: 4 }}>
                  {transcript.title && <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a1a", margin: "0 0 4px" }}>{transcript.title}</h3>}
                  {transcript.date && <p style={{ fontSize: 12, color: "#999", margin: "0 0 16px", fontFamily: "sans-serif" }}>{transcript.date}</p>}
                  <div className="tx-body" style={{ fontSize: 15, lineHeight: 1.9, color: "#222" }} dangerouslySetInnerHTML={{ __html: transcript.content }} />
                </div>
              )}
              {!txLoading && !transcript && !txError && !selectedEp.transcriptUrl && <p style={{ color: "#888", fontFamily: "sans-serif", fontSize: 14 }}>No transcript link available for this episode.</p>}
            </div>
          </>}
        </main>
      </div>

      <footer style={{ background: "#1a1a1a", color: "#777", textAlign: "center", padding: "1.25rem", fontSize: 12, fontFamily: "sans-serif" }}>
        Content © <a href="https://www.bbc.co.uk/learningenglish/" target="_blank" rel="noopener" style={{ color: "#b11116" }}>BBC Learning English</a>. Episodes fetched live via iTunes API.
      </footer>

      <style>{`
        nav::-webkit-scrollbar{display:none}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}
        .tx-body p{margin:0 0 1rem}
        .tx-body h2,.tx-body h3{font-size:16px;margin:1.5rem 0 .5rem;color:#333}
        .tx-body strong,.tx-body b{font-weight:700;color:#111}
        .tx-body a{color:#b11116;text-decoration:none}
      `}</style>
    </div>
  );
}