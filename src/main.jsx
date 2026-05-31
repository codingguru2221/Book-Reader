import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  FileText,
  Globe2,
  Loader2,
  Pause,
  Play,
  Search,
  Sparkles,
  Square,
  Upload,
  Volume2,
  Wand2
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

const sampleText = `Books let us borrow another person's mind for a while. A careful reader does not only read words; they listens for ideas, emotions, questions, and the quiet assumptions behind each line.

Select any word, line, or paragraph. Then ask the AI to explain it in simple language, search the web, or find a Wikipedia background note.`;

function splitLines(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n\n");
}

function App() {
  const [bookText, setBookText] = useState(sampleText);
  const [selectedText, setSelectedText] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [searchItems, setSearchItems] = useState([]);
  const [wikiItems, setWikiItems] = useState([]);
  const [loading, setLoading] = useState("");
  const [voiceState, setVoiceState] = useState("idle");
  const textAreaRef = useRef(null);

  const lines = useMemo(() => splitLines(bookText), [bookText]);
  const context = useMemo(() => bookText.slice(0, 5000), [bookText]);

  const activeText = selectedText || question || lines[0] || "";

  function captureSelection() {
    const area = textAreaRef.current;
    if (!area) return;
    const text = area.value.slice(area.selectionStart, area.selectionEnd).trim();
    if (text) setSelectedText(text);
  }

  async function handleFile(file) {
    if (!file) return;
    setLoading("file");
    try {
      const text = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
        ? await extractPdfText(file)
        : await file.text();
      setBookText(text.trim() || sampleText);
      setSelectedText("");
      setAnswer("");
    } catch (error) {
      setAnswer(`File read nahi ho paayi: ${error.message}`);
    } finally {
      setLoading("");
    }
  }

  async function explain(mode) {
    const text = mode === "question" ? `${question}\n\nSelected: ${activeText}` : activeText;
    if (!text.trim()) return;
    setLoading(mode);
    setAnswer("");
    try {
      const response = await fetch(`${API_BASE}/api/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode, context, language: "Hinglish" })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI request failed");
      setAnswer(data.text);
    } catch (error) {
      setAnswer(error.message);
    } finally {
      setLoading("");
    }
  }

  async function lookup(kind) {
    const q = (selectedText || question || "").trim();
    if (!q) return;
    setLoading(kind);
    try {
      const response = await fetch(`${API_BASE}/api/${kind}?q=${encodeURIComponent(q)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `${kind} lookup failed`);
      if (kind === "search") setSearchItems(data.items || []);
      if (kind === "wiki") setWikiItems(data.items || []);
    } catch (error) {
      setAnswer(error.message);
    } finally {
      setLoading("");
    }
  }

  function speak() {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(activeText || bookText.slice(0, 1200));
    utterance.lang = "en-IN";
    utterance.rate = 0.95;
    utterance.onend = () => setVoiceState("idle");
    setVoiceState("playing");
    window.speechSynthesis.speak(utterance);
  }

  function pauseVoice() {
    window.speechSynthesis.pause();
    setVoiceState("paused");
  }

  function resumeVoice() {
    window.speechSynthesis.resume();
    setVoiceState("playing");
  }

  function stopVoice() {
    window.speechSynthesis.cancel();
    setVoiceState("idle");
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brand">
          <BookOpen size={28} />
          <div>
            <h1>Book Reader AI</h1>
            <p>Read, listen, explain, search, and understand.</p>
          </div>
        </div>
        <label className="uploadButton" title="Upload .txt, .md, or .pdf">
          {loading === "file" ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
          <span>Upload</span>
          <input type="file" accept=".txt,.md,.pdf,text/*,application/pdf" onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </section>

      <section className="workspace">
        <div className="readerPane">
          <div className="paneHeader">
            <div>
              <h2>Book Text</h2>
              <p>Select a word, line, or paragraph from the text.</p>
            </div>
            <div className="voiceControls">
              <button onClick={speak} title="Read aloud"><Play size={17} /></button>
              <button onClick={voiceState === "paused" ? resumeVoice : pauseVoice} title="Pause or resume">
                {voiceState === "paused" ? <Volume2 size={17} /> : <Pause size={17} />}
              </button>
              <button onClick={stopVoice} title="Stop"><Square size={17} /></button>
            </div>
          </div>
          <textarea
            ref={textAreaRef}
            value={bookText}
            onChange={(event) => setBookText(event.target.value)}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            spellCheck="false"
          />
        </div>

        <aside className="assistantPane">
          <div className="selectedBox">
            <FileText size={18} />
            <p>{selectedText || "Text select karo, ya neeche question likho."}</p>
          </div>

          <div className="actions">
            <button onClick={() => explain("word")}><Wand2 size={17} /> Word</button>
            <button onClick={() => explain("line")}><Sparkles size={17} /> Line</button>
            <button onClick={() => explain("summary")}><FileText size={17} /> Summary</button>
            <button onClick={() => lookup("wiki")}><Globe2 size={17} /> Wiki</button>
            <button onClick={() => lookup("search")}><Search size={17} /> Search</button>
          </div>

          <div className="questionBox">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask: is line ka matlab kya hai?"
            />
            <button onClick={() => explain("question")} disabled={!question.trim()}>
              {loading === "question" ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
            </button>
          </div>

          <section className="answerPanel">
            <h2>AI Explanation</h2>
            {loading && loading !== "file" ? <p className="muted">Thinking...</p> : <p>{answer || "Explanation yahan dikhegi."}</p>}
          </section>

          <ResultList title="Wikipedia" items={wikiItems} />
          <ResultList title="Google Search" items={searchItems} />
        </aside>
      </section>
    </main>
  );
}

function ResultList({ title, items }) {
  if (!items.length) return null;
  return (
    <section className="results">
      <h2>{title}</h2>
      {items.map((item) => (
        <a key={item.url || item.link || item.title} href={item.url || item.link} target="_blank" rel="noreferrer">
          <strong>{item.title}</strong>
          <span>{item.extract || item.snippet}</span>
        </a>
      ))}
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
