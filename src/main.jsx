import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe2,
  Loader2,
  Pause,
  Play,
  Search,
  Sparkles,
  Square,
  Type,
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
const MAX_PDF_RENDER_WIDTH = 920;
const DEFAULT_VOICE_RATE = 0.72;
const FALLBACK_WORD_DELAY_MS = 1700;

function scoreVoice(voice) {
  const name = `${voice.name} ${voice.lang}`.toLowerCase();
  let score = 0;
  if (name.includes("google")) score += 6;
  if (name.includes("microsoft")) score += 5;
  if (name.includes("natural")) score += 5;
  if (name.includes("online")) score += 4;
  if (name.includes("female")) score += 2;
  if (name.includes("india") || name.includes("en-in") || name.includes("hi-in")) score += 6;
  if (name.includes("english")) score += 2;
  return score;
}

function chooseHumanVoice(voices) {
  return [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

const sampleText = `Books let us borrow another person's mind for a while. A careful reader does not only read words; they listens for ideas, emotions, questions, and the quiet assumptions behind each line.

Select any word, line, or paragraph. Then ask the AI to explain it in simple language, search the web, or find a Wikipedia background note.`;

function splitLines(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildPdfWordLayer(content, viewport, pageNumber) {
  const words = [];
  const scale = viewport.scale || 1;

  content.items.forEach((item, itemIndex) => {
    const raw = item.str || "";
    const clean = raw.trim();
    if (!clean) return;

    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(8, Math.hypot(transform[2], transform[3]));
    const itemWidth = Math.max(item.width * scale, clean.length * fontSize * 0.35);
    const tokens = raw.match(/\S+/g) || [];
    const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || clean.length;
    let charOffset = 0;

    tokens.forEach((token, tokenIndex) => {
      const width = Math.max(10, (itemWidth * token.length) / totalChars);
      const x = transform[4] + (itemWidth * charOffset) / totalChars;
      const y = transform[5] - fontSize;
      const id = `${pageNumber}-${itemIndex}-${tokenIndex}`;
      words.push({
        id,
        pageNumber,
        text: token,
        x,
        y,
        width,
        height: fontSize * 1.15,
        fontSize
      });
      charOffset += token.length + 1;
    });
  });

  return words;
}

function median(values, fallback = 0) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function lineBounds(words) {
  const minX = Math.min(...words.map((word) => word.x));
  const maxX = Math.max(...words.map((word) => word.x + word.width));
  return { minX, maxX, width: maxX - minX };
}

function createVisualLines(page) {
  const buckets = new Map();
  const typicalFont = median(page.words.map((word) => word.fontSize), 10);
  const yTolerance = Math.max(4, typicalFont * 0.55);

  page.words.forEach((word) => {
    const key = Math.round(word.y / yTolerance) * yTolerance;
    const group = buckets.get(key) || [];
    group.push(word);
    buckets.set(key, group);
  });

  return [...buckets.entries()]
    .flatMap(([y, words]) => {
      const ordered = words.sort((a, b) => a.x - b.x);
      const avgFont = ordered.reduce((sum, word) => sum + word.fontSize, 0) / ordered.length;
      const gapThreshold = Math.max(avgFont * 2.2, page.width * 0.028);
      const segments = [];
      let current = [];

      ordered.forEach((word) => {
        const previous = current[current.length - 1];
        const gap = previous ? word.x - (previous.x + previous.width) : 0;
        if (previous && gap > gapThreshold) {
          segments.push(current);
          current = [];
        }
        current.push(word);
      });
      if (current.length) segments.push(current);

      return segments.map((segmentWords, segmentIndex) => {
        const bounds = lineBounds(segmentWords);
        return {
          id: `${page.pageNumber}-line-${Math.round(y)}-${segmentIndex}`,
          y,
          height: Math.max(...segmentWords.map((word) => word.height)),
          avgFont,
          words: segmentWords,
          text: segmentWords.map((word) => word.text).join(" "),
          ...bounds
        };
      });
    })
    .sort((a, b) => a.y - b.y || a.minX - b.minX);
}

function horizontalOverlap(a, b) {
  const overlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  return overlap / Math.max(1, Math.min(a.width, b.width));
}

function createLayoutRegions(page, lines) {
  const typicalFont = median(lines.map((line) => line.avgFont), 10);
  const regions = [];

  lines.forEach((line) => {
    const candidate = regions.find((region) => {
      const previous = region.lines[region.lines.length - 1];
      const verticalGap = line.y - (previous.y + previous.height);
      const closeVertically = verticalGap < typicalFont * 3.4;
      const sameLane = horizontalOverlap(region, line) > 0.34
        || Math.abs(region.minX - line.minX) < page.width * 0.035;
      return closeVertically && sameLane;
    });

    if (candidate) {
      candidate.lines.push(line);
      candidate.minX = Math.min(candidate.minX, line.minX);
      candidate.maxX = Math.max(candidate.maxX, line.maxX);
      candidate.width = candidate.maxX - candidate.minX;
      candidate.minY = Math.min(candidate.minY, line.y);
      candidate.maxY = Math.max(candidate.maxY, line.y + line.height);
      return;
    }

    regions.push({
      id: `${page.pageNumber}-region-${regions.length}`,
      lines: [line],
      minX: line.minX,
      maxX: line.maxX,
      width: line.width,
      minY: line.y,
      maxY: line.y + line.height
    });
  });

  const maxRegionWidth = Math.max(...regions.map((region) => region.width), page.width * 0.6);
  const medianRegionFont = median(lines.map((line) => line.avgFont), 10);
  regions.forEach((region) => {
    const avgFont = median(region.lines.map((line) => line.avgFont), medianRegionFont);
    const shortRegion = region.lines.length <= 2;
    const rightSide = region.minX > page.width * 0.58;
    const narrow = region.width < maxRegionWidth * 0.48;
    const centered = region.minX > page.width * 0.18 && region.maxX < page.width * 0.82;
    const headingLike = shortRegion && centered && avgFont > medianRegionFont * 1.12;
    const captionLike = region.lines.length <= 3 && narrow && avgFont < medianRegionFont * 0.9;
    const quoteLike = narrow && region.minX > page.width * 0.12 && !rightSide && region.lines.length >= 2;

    region.type = headingLike
      ? "heading"
      : rightSide && narrow
        ? "note"
        : captionLike
          ? "caption"
          : quoteLike
            ? "quote"
            : "body";
  });

  return regions;
}

function createParagraphBlocks(page, regions) {
  const blocks = [];
  regions.forEach((region) => {
    const typicalHeight = median(region.lines.map((line) => line.height), 10);
    let current = [];

    function flush() {
      if (!current.length) return;
      blocks.push({
        id: `${region.id}-block-${blocks.length}`,
        pageNumber: page.pageNumber,
        type: region.type,
        regionId: region.id,
        minX: Math.min(...current.map((line) => line.minX)),
        minY: Math.min(...current.map((line) => line.y)),
        words: current.flatMap((line) => line.words),
        lines: current
      });
      current = [];
    }

    region.lines
      .sort((a, b) => a.y - b.y)
      .forEach((line) => {
        const previous = current[current.length - 1];
        if (!previous) {
          current.push(line);
          return;
        }

        const gap = line.y - (previous.y + previous.height);
        const indentation = Math.abs(line.minX - previous.minX);
        const paragraphBreak = gap > typicalHeight * 1.05
          || indentation > page.width * 0.035
          || region.type === "heading";
        if (paragraphBreak) flush();
        current.push(line);
      });
    flush();
  });

  return blocks;
}

function orderReadingBlocks(page, blocks) {
  const headings = blocks.filter((block) => block.type === "heading");
  const notes = blocks.filter((block) => block.type === "note");
  const flow = blocks.filter((block) => block.type !== "heading" && block.type !== "note");
  const laneTolerance = page.width * 0.12;
  const firstFlowY = Math.min(...flow.map((block) => block.minY), page.height);
  const topHeadings = headings.filter((block) => block.minY <= firstFlowY + page.height * 0.04);
  const inlineHeadings = headings.filter((block) => !topHeadings.includes(block));

  const orderedFlow = [...flow, ...inlineHeadings].sort((a, b) => {
    const sameLane = Math.abs(a.minX - b.minX) < laneTolerance;
    return sameLane ? a.minY - b.minY : a.minX - b.minX || a.minY - b.minY;
  });
  headings.sort((a, b) => a.minY - b.minY);
  notes.sort((a, b) => a.minY - b.minY);

  return [...topHeadings, ...orderedFlow, ...notes];
}

function serializeTranscriptBlocks(page, blocks) {
  const transcript = [];
  let textOffset = 0;

  blocks.forEach((block, index) => {
    const separatorBefore = index === 0 ? "" : "\n\n";
    textOffset += separatorBefore.length;
    let text = "";
    const wordIds = [];
    const wordStarts = [];

    block.words.forEach((word, wordIndex) => {
      const previousWord = block.words[wordIndex - 1];
      const joinsWrappedWord = wordIndex > 0 && previousWord.text.endsWith("-");
      if (joinsWrappedWord && text.endsWith("-")) text = text.slice(0, -1);
      const needsSpace = wordIndex > 0 && !joinsWrappedWord;
      if (needsSpace) text += " ";
      const absoluteStart = textOffset + text.length;
      word.charStart = absoluteStart;
      wordStarts.push(absoluteStart);
      wordIds.push(word.id);
      text += word.text;
      word.charEnd = textOffset + text.length;
      word.lineId = block.id;
    });

    if (!text.trim()) return;
    transcript.push({
      id: block.id,
      pageNumber: page.pageNumber,
      section: block.type,
      text,
      start: textOffset,
      end: textOffset + text.length,
      separatorBefore,
      wordIds,
      wordStarts
    });
    textOffset += text.length;
  });

  return transcript;
}

function buildTranscript(page) {
  const lines = createVisualLines(page);
  const regions = createLayoutRegions(page, lines);
  const blocks = createParagraphBlocks(page, regions);
  return serializeTranscriptBlocks(page, orderReadingBlocks(page, blocks));
}

function buildReadingText(transcript) {
  return transcript.map((block) => `${block.separatorBefore}${block.text}`).join("");
}

async function loadPdfPage(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.25, MAX_PDF_RENDER_WIDTH / baseViewport.width);
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent();
  const words = buildPdfWordLayer(content, viewport, pageNumber);
  const pageData = {
    page,
    pageNumber,
    viewport,
    width: viewport.width,
    height: viewport.height,
    words,
    text: words.map((word) => word.text).join(" ")
  };
  const transcript = buildTranscript(pageData);
  return {
    ...pageData,
    transcript,
    text: buildReadingText(transcript)
  };
}

async function openPdfDocument(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  return {
    pdfDoc: pdf,
    pageCount: pdf.numPages
  };
}

function keepSmallPageCache(cache, pageNumber, pageData) {
  const nextCache = { ...cache, [pageNumber]: pageData };
  Object.keys(nextCache).forEach((key) => {
    const cachedPage = Number(key);
    if (Math.abs(cachedPage - pageNumber) > 1) {
      delete nextCache[key];
    }
  });
  return nextCache;
}

function App() {
  const [bookText, setBookText] = useState(sampleText);
  const [documentMode, setDocumentMode] = useState("text");
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [currentPdfPage, setCurrentPdfPage] = useState(1);
  const [pdfPageData, setPdfPageData] = useState(null);
  const [pdfPageCache, setPdfPageCache] = useState({});
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [activeWordId, setActiveWordId] = useState("");
  const [activeLineId, setActiveLineId] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [searchItems, setSearchItems] = useState([]);
  const [wikiItems, setWikiItems] = useState([]);
  const [loading, setLoading] = useState("");
  const [voiceState, setVoiceState] = useState("idle");
  const [autoReading, setAutoReading] = useState(false);
  const [readerMenu, setReaderMenu] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const textAreaRef = useRef(null);
  const autoReadingRef = useRef(false);
  const autoSpeakingRef = useRef(false);
  const currentPdfPageRef = useRef(1);
  const pdfPageCountRef = useRef(0);
  const currentSpeechRef = useRef({ kind: "none", charIndex: 0 });
  const ignoreSpeechEndRef = useRef(false);
  const playbackSessionRef = useRef(0);
  const syncTimerRef = useRef(null);
  const syncAnchorRef = useRef({ charIndex: 0, time: 0 });
  const voiceStateRef = useRef("idle");
  const voiceSwitchTokenRef = useRef(0);

  const lines = useMemo(() => splitLines(bookText), [bookText]);
  const context = useMemo(() => bookText.slice(0, 5000), [bookText]);
  const transcriptIndex = useMemo(
    () => transcriptLines.findIndex((line) => line.id === activeLineId),
    [activeLineId, transcriptLines]
  );

  const activeText = selectedText || question || lines[0] || "";
  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voiceURI === selectedVoiceURI) || chooseHumanVoice(voices),
    [selectedVoiceURI, voices]
  );

  useEffect(() => {
    function loadVoices() {
      const available = window.speechSynthesis?.getVoices?.() || [];
      setVoices(available);
      const best = chooseHumanVoice(available);
      if (best && !selectedVoiceURI) setSelectedVoiceURI(best.voiceURI);
    }

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [selectedVoiceURI]);

  useEffect(() => {
    autoReadingRef.current = autoReading;
  }, [autoReading]);

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  useEffect(() => {
    currentPdfPageRef.current = currentPdfPage;
    pdfPageCountRef.current = pdfPageCount;
  }, [currentPdfPage, pdfPageCount]);

  useEffect(() => {
    return () => {
      clearHighlightSyncTimer();
      window.speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    function closeMenu(event) {
      if (!event.target.closest?.(".readerMenu") && !event.target.closest?.(".pdfWord")) {
        setReaderMenu(null);
      }
    }

    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, []);

  useEffect(() => {
    let ignore = false;
    if (!pdfDoc || documentMode !== "pdf") return undefined;

    async function loadActivePage() {
      setLoading("page");
      setActiveWordId("");
      setActiveLineId("");
      try {
        const cached = pdfPageCache[currentPdfPage];
        const pageData = cached || await loadPdfPage(pdfDoc, currentPdfPage);
        if (ignore) return;
        setPdfPageData(pageData);
        setTranscriptLines(pageData.transcript);
        setBookText(pageData.text.trim() || `Page ${currentPdfPage}`);
        if (!cached) {
          setPdfPageCache((cache) => keepSmallPageCache(cache, currentPdfPage, pageData));
        }
      } catch (error) {
        if (!ignore) setAnswer(`Page load nahi ho paayi: ${error.message}`);
      } finally {
        if (!ignore) setLoading("");
      }
    }

    loadActivePage();
    return () => {
      ignore = true;
    };
  }, [currentPdfPage, documentMode, pdfDoc]);

  function cancelSpeech() {
    ignoreSpeechEndRef.current = true;
    playbackSessionRef.current += 1;
    clearHighlightSyncTimer();
    window.speechSynthesis.cancel();
    window.setTimeout(() => {
      ignoreSpeechEndRef.current = false;
    }, 120);
  }

  function clearHighlightSyncTimer() {
    if (syncTimerRef.current) {
      window.clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }

  function nextWordCharAfter(charIndex) {
    const allStarts = transcriptLines
      .flatMap((line) => line.wordStarts || [])
      .filter((start) => start > charIndex)
      .sort((a, b) => a - b);
    return allStarts[0] ?? charIndex;
  }

  function startPdfHighlightSync(sessionId, startChar, textLength, rate = DEFAULT_VOICE_RATE) {
    clearHighlightSyncTimer();
    syncAnchorRef.current = { charIndex: startChar, time: performance.now() };

    syncTimerRef.current = window.setInterval(() => {
      const speech = currentSpeechRef.current;
      if (
        playbackSessionRef.current !== sessionId ||
        speech.kind !== "pdf" ||
        voiceStateRef.current === "paused"
      ) {
        return;
      }

      const elapsed = performance.now() - syncAnchorRef.current.time;
      if (elapsed < FALLBACK_WORD_DELAY_MS / Math.max(rate, 0.5)) return;

      const nextChar = Math.min(startChar + textLength - 1, nextWordCharAfter(speech.charIndex || startChar));
      if (nextChar <= (speech.charIndex || startChar)) return;

      currentSpeechRef.current = { ...speech, charIndex: nextChar };
      syncAnchorRef.current = { charIndex: nextChar, time: performance.now() };
      highlightPdfAtChar(nextChar);
    }, 180);
  }

  function restartPdfHighlightSyncFromCurrent() {
    const speech = currentSpeechRef.current;
    if (speech.kind !== "pdf" || !speech.sessionId) return;
    const endChar = (speech.startChar || 0) + (speech.textLength || 0);
    const remainingLength = Math.max(1, endChar - (speech.charIndex || 0));
    startPdfHighlightSync(
      speech.sessionId,
      speech.charIndex || speech.startChar || 0,
      remainingLength,
      speech.rate || DEFAULT_VOICE_RATE
    );
  }

  useEffect(() => {
    if (!autoReading || autoSpeakingRef.current || loading === "page") return;
    if (!pdfPageData || pdfPageData.pageNumber !== currentPdfPage) return;
    if (!pdfPageData?.text?.trim()) {
      if (currentPdfPage < pdfPageCount) {
        setSelectedText(`Page ${currentPdfPage} has no readable text. Skipping...`);
        setCurrentPdfPage((page) => Math.min(page + 1, pdfPageCount));
        return;
      }
      setSelectedText("Is PDF mein readable text nahi mila. Agar ye scanned book hai to OCR add karna padega.");
      setAutoReading(false);
      setVoiceState("idle");
      return;
    }
    speakPdfPage(true);
  }, [autoReading, currentPdfPage, loading, pdfPageCount, pdfPageData]);

  function captureSelection() {
    const area = textAreaRef.current;
    if (!area) return;
    const text = area.value.slice(area.selectionStart, area.selectionEnd).trim();
    if (text) setSelectedText(text);
  }

  async function handleFile(file) {
    if (!file) return;
    setLoading("file");
    cancelSpeech();
    autoSpeakingRef.current = false;
    setAutoReading(false);
    try {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const pdf = await openPdfDocument(file);
        setDocumentMode("pdf");
        setPdfDoc(pdf.pdfDoc);
        setPdfPageCount(pdf.pageCount);
        setCurrentPdfPage(1);
        setPdfPageData(null);
        setPdfPageCache({});
        setTranscriptLines([]);
        setBookText("");
      } else {
        const text = await file.text();
        setDocumentMode("text");
        setPdfDoc(null);
        setPdfPageCount(0);
        setCurrentPdfPage(1);
        setPdfPageData(null);
        setPdfPageCache({});
        setTranscriptLines([]);
        setBookText(text.trim() || sampleText);
      }
      setSelectedText("");
      setAnswer("");
      setActiveWordId("");
      setActiveLineId("");
    } catch (error) {
      setAnswer(`File read nahi ho paayi: ${error.message}`);
    } finally {
      setLoading("");
    }
  }

  async function explain(mode) {
    const text = mode === "question" ? `${question}\n\nSelected: ${activeText}` : activeText;
    return explainSelectedText(text, mode);
  }

  async function explainSelectedText(text, mode = "line") {
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
    return lookupText(kind, selectedText || question || "");
  }

  async function lookupText(kind, query) {
    const q = query.trim();
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

  function makeUtterance(text, options = {}) {
    const utterance = new SpeechSynthesisUtterance(text || activeText || bookText.slice(0, 1200));
    const voice = options.voiceURI
      ? voices.find((item) => item.voiceURI === options.voiceURI) || selectedVoice
      : selectedVoice;
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || "en-IN";
    utterance.rate = options.rate || DEFAULT_VOICE_RATE;
    utterance.pitch = options.pitch || 1.04;
    utterance.volume = options.volume || 1;
    return utterance;
  }

  function speakText(text, wordId = "", lineId = "", options = {}) {
    setAutoReading(false);
    cancelSpeech();
    const sessionId = playbackSessionRef.current;
    const utterance = makeUtterance(text, options);
    currentSpeechRef.current = { kind: "text", sessionId, text, wordId, lineId, options, charIndex: 0 };
    utterance.onboundary = (event) => {
      if (currentSpeechRef.current.sessionId !== sessionId) return;
      if (event.charIndex !== undefined) {
        currentSpeechRef.current = { ...currentSpeechRef.current, charIndex: event.charIndex };
      }
    };
    utterance.onend = () => {
      if (currentSpeechRef.current.sessionId !== sessionId) return;
      if (ignoreSpeechEndRef.current) {
        ignoreSpeechEndRef.current = false;
        return;
      }
      currentSpeechRef.current = { kind: "none", charIndex: 0 };
      setVoiceState("idle");
    };
    setActiveWordId(wordId);
    setActiveLineId(lineId);
    setVoiceState("playing");
    window.speechSynthesis.speak(utterance);
  }

  async function narrateLikeTeacher() {
    const text = selectedText || pdfPageData?.text || activeText || bookText.slice(0, 2500);
    if (!text.trim()) return;
    setAutoReading(false);
    setLoading("narrate");
    setAnswer("");
    try {
      const response = await fetch(`${API_BASE}/api/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode: "narrate", context, language: "Hinglish" })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Narration failed");
      setAnswer(data.text);
      speakText(data.text, activeWordId, activeLineId, { rate: 0.7, pitch: 1.04 });
    } catch (error) {
      setAnswer(error.message);
    } finally {
      setLoading("");
    }
  }

  function speakTranscriptFrom(startIndex = 0) {
    if (!transcriptLines.length) {
      speakText(activeText || bookText.slice(0, 1200));
      return;
    }

    const line = transcriptLines[Math.max(0, startIndex)];
    if (!line) {
      setVoiceState("idle");
      return;
    }

    cancelSpeech();
    const utterance = makeUtterance(line.text);
    utterance.onstart = () => {
      setSelectedText(line.text);
      setActiveLineId(line.id);
      setActiveWordId(line.wordIds[0] || "");
      setVoiceState("playing");
    };
    utterance.onboundary = (event) => {
      if (event.name !== "word" && event.charIndex === undefined) return;
      const spoken = line.text.slice(0, event.charIndex).trim().split(/\s+/).filter(Boolean).length;
      setActiveWordId(line.wordIds[Math.min(spoken, line.wordIds.length - 1)] || "");
    };
    utterance.onend = () => {
      if (ignoreSpeechEndRef.current) {
        ignoreSpeechEndRef.current = false;
        return;
      }
      if (startIndex + 1 < transcriptLines.length) speakTranscriptFrom(startIndex + 1);
      else setVoiceState("idle");
    };
    window.speechSynthesis.speak(utterance);
  }

  function speak() {
    if (voiceState === "paused" || window.speechSynthesis.paused) {
      resumeVoice();
      return;
    }

    if (documentMode === "pdf" && pdfDoc && pdfPageCount) {
      autoSpeakingRef.current = false;
      setVoiceState("playing");
      setAutoReading(true);
      return;
    }
    speakText(activeText || bookText.slice(0, 1200));
  }

  function highlightPdfAtChar(charIndex) {
    const line = transcriptLines.find((item) => charIndex >= item.start && charIndex <= item.end)
      || transcriptLines.find((item) => charIndex < item.end)
      || transcriptLines[0];
    if (!line) return;

    const wordIndex = Math.max(
      0,
      line.wordStarts.findLastIndex((start) => start <= charIndex)
    );
    setSelectedText(line.text);
    setActiveLineId(line.id);
    setActiveWordId(line.wordIds[wordIndex] || line.wordIds[0] || "");
  }

  function speakPdfPage(continueAcrossPages = false, options = {}) {
    if (!pdfPageData?.text) return;
    cancelSpeech();
    const sessionId = playbackSessionRef.current;
    autoSpeakingRef.current = continueAcrossPages;
    const startChar = Math.max(0, Math.min(options.startChar || 0, pdfPageData.text.length - 1));
    const spokenText = pdfPageData.text.slice(startChar);
    const utterance = makeUtterance(spokenText, options);
    currentSpeechRef.current = {
      kind: "pdf",
      sessionId,
      pageNumber: pdfPageData.pageNumber,
      continueAcrossPages,
      startChar,
      textLength: spokenText.length,
      rate: options.rate || DEFAULT_VOICE_RATE,
      charIndex: startChar
    };
    highlightPdfAtChar(startChar);
    utterance.onstart = () => {
      if (currentSpeechRef.current.sessionId !== sessionId) return;
      highlightPdfAtChar(startChar);
      setVoiceState("playing");
      startPdfHighlightSync(sessionId, startChar, spokenText.length, options.rate || DEFAULT_VOICE_RATE);
    };
    utterance.onboundary = (event) => {
      if (currentSpeechRef.current.sessionId !== sessionId) return;
      if (event.charIndex === undefined) return;
      const absoluteChar = startChar + event.charIndex;
      currentSpeechRef.current = {
        ...currentSpeechRef.current,
        charIndex: absoluteChar
      };
      syncAnchorRef.current = { charIndex: absoluteChar, time: performance.now() };
      highlightPdfAtChar(absoluteChar);
    };
    utterance.onend = () => {
      if (currentSpeechRef.current.sessionId !== sessionId) return;
      if (ignoreSpeechEndRef.current) {
        ignoreSpeechEndRef.current = false;
        return;
      }
      clearHighlightSyncTimer();
      autoSpeakingRef.current = false;
      const hasNextPage = currentPdfPageRef.current < pdfPageCountRef.current;
      if (continueAcrossPages && autoReadingRef.current && hasNextPage) {
        setPdfPageData(null);
        setTranscriptLines([]);
        setCurrentPdfPage((page) => Math.min(page + 1, pdfPageCountRef.current));
        return;
      }
      setAutoReading(false);
      currentSpeechRef.current = { kind: "none", charIndex: 0 };
      setVoiceState("idle");
    };
    window.speechSynthesis.speak(utterance);
  }

  function handleVoiceChange(voiceURI) {
    setSelectedVoiceURI(voiceURI);
    if (voiceState !== "playing" && voiceState !== "paused") return;

    const switchToken = voiceSwitchTokenRef.current + 1;
    voiceSwitchTokenRef.current = switchToken;
    const current = currentSpeechRef.current;
    cancelSpeech();
    autoSpeakingRef.current = false;

    window.setTimeout(() => {
      if (voiceSwitchTokenRef.current !== switchToken) return;
      if (current.kind === "pdf" && pdfPageData?.pageNumber === current.pageNumber) {
        const lineStart = transcriptLines.find((line) => current.charIndex >= line.start && current.charIndex <= line.end)?.start ?? current.charIndex ?? 0;
        highlightPdfAtChar(lineStart);
        setAutoReading(current.continueAcrossPages);
        speakPdfPage(current.continueAcrossPages, { voiceURI, startChar: lineStart });
        return;
      }

      if (current.kind === "text") {
        speakText(current.text, current.wordId, current.lineId, { ...current.options, voiceURI });
      }
    }, 80);
  }

  function pauseVoice() {
    window.speechSynthesis.pause();
    voiceStateRef.current = "paused";
    clearHighlightSyncTimer();
    setVoiceState("paused");
  }

  function resumeVoice() {
    window.speechSynthesis.resume();
    voiceStateRef.current = "playing";
    restartPdfHighlightSyncFromCurrent();
    setVoiceState("playing");
  }

  function stopVoice() {
    cancelSpeech();
    autoSpeakingRef.current = false;
    setAutoReading(false);
    setVoiceState("idle");
  }

  function openReaderMenu(word, event) {
    event.preventDefault();
    event.stopPropagation();
    const line = transcriptLines.find((item) => item.id === word.lineId)
      || transcriptLines.find((item) => word.charStart >= item.start && word.charStart <= item.end);
    const menuText = line?.text || word.text;
    setSelectedText(menuText);
    setReaderMenu({
      id: `${word.id}-${Date.now()}`,
      x: Math.min(event.clientX + 8, window.innerWidth - 240),
      y: Math.min(event.clientY + 8, window.innerHeight - 300),
      word,
      line,
      text: menuText,
      pageNumber: word.pageNumber,
      charStart: word.charStart ?? line?.start ?? 0
    });
  }

  function selectTranscriptLine(line) {
    setSelectedText(line.text);
    setActiveLineId(line.id);
    setActiveWordId(line.wordIds[0] || "");
    speakText(line.text, line.wordIds[0] || "", line.id, { rate: 0.72, pitch: 1.04 });
  }

  function readFromMenuPosition() {
    if (!readerMenu) return;
    setAutoReading(true);
    setReaderMenu(null);
    speakPdfPage(true, { startChar: readerMenu.charStart || 0 });
  }

  async function searchMenuText() {
    if (!readerMenu) return;
    const query = readerMenu.word?.text || readerMenu.text;
    setReaderMenu(null);
    setSelectedText(query);
    await Promise.all([lookupText("wiki", query), lookupText("search", query)]);
  }

  async function explainMenuText() {
    if (!readerMenu) return;
    const text = readerMenu.text;
    setReaderMenu(null);
    setSelectedText(text);
    await explainSelectedText(text, "line");
  }

  async function translateMenuText() {
    if (!readerMenu) return;
    const text = `Translate this into simple Hindi/Hinglish and explain any difficult phrase:\n\n${readerMenu.text}`;
    setReaderMenu(null);
    await explainSelectedText(text, "question");
  }

  async function copyMenuText() {
    if (!readerMenu) return;
    await navigator.clipboard?.writeText(readerMenu.text);
    setSelectedText(`Copied: ${readerMenu.text}`);
    setReaderMenu(null);
  }

  function bookmarkMenuPosition() {
    if (!readerMenu) return;
    const bookmark = {
      id: readerMenu.id,
      pageNumber: readerMenu.pageNumber,
      charStart: readerMenu.charStart,
      text: readerMenu.text.slice(0, 140)
    };
    setBookmarks((items) => [bookmark, ...items].slice(0, 20));
    setSelectedText(`Bookmarked p${bookmark.pageNumber}: ${bookmark.text}`);
    setReaderMenu(null);
  }

  function changePdfPage(nextPage) {
    const page = Math.min(Math.max(nextPage, 1), pdfPageCount || 1);
    if (page === currentPdfPage) return;
    cancelSpeech();
    autoSpeakingRef.current = false;
    setAutoReading(false);
    setVoiceState("idle");
    setSelectedText("");
    setPdfPageData(null);
    setTranscriptLines([]);
    setCurrentPdfPage(page);
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
              <h2>{documentMode === "pdf" ? "PDF Reader" : "Book Text"}</h2>
              <p>{documentMode === "pdf" ? "Click underlined words on the PDF, or use transcript." : "Select a word, line, or paragraph from the text."}</p>
            </div>
            <div className="voiceControls">
              {documentMode === "pdf" && (
                <>
                  <button onClick={() => changePdfPage(currentPdfPage - 1)} disabled={currentPdfPage <= 1 || loading === "page"} title="Previous page"><ChevronLeft size={17} /></button>
                  <span className="pageCounter">{currentPdfPage}/{pdfPageCount || "..."}</span>
                  <button onClick={() => changePdfPage(currentPdfPage + 1)} disabled={currentPdfPage >= pdfPageCount || loading === "page"} title="Next page"><ChevronRight size={17} /></button>
                </>
              )}
              <button onClick={speak} title="Read aloud"><Play size={17} /></button>
              <button onClick={narrateLikeTeacher} disabled={loading === "narrate"} title="AI narration">
                {loading === "narrate" ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
              </button>
              <button onClick={voiceState === "paused" ? resumeVoice : pauseVoice} title="Pause or resume">
                {voiceState === "paused" ? <Volume2 size={17} /> : <Pause size={17} />}
              </button>
              <button onClick={stopVoice} title="Stop"><Square size={17} /></button>
            </div>
          </div>
          {documentMode === "pdf" ? (
            <PdfViewer
              page={pdfPageData}
              loading={loading === "page" || loading === "file"}
              activeWordId={activeWordId}
              activeLine={transcriptLines.find((line) => line.id === activeLineId)}
              onWordClick={openReaderMenu}
            />
          ) : (
            <textarea
              ref={textAreaRef}
              value={bookText}
              onChange={(event) => setBookText(event.target.value)}
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              spellCheck="false"
            />
          )}
        </div>

        <aside className="assistantPane">
          {documentMode === "pdf" && (
            <section className="transcriptPanel">
              <div className="miniHeader">
                <Type size={17} />
                <h2>Transcript</h2>
              </div>
              <div className="transcriptList">
                {loading === "page" && <p className="muted">Page transcript loading...</p>}
                {transcriptLines.map((line) => (
                  <button
                    key={line.id}
                    className={line.id === activeLineId ? "transcriptLine active" : "transcriptLine"}
                    onClick={() => selectTranscriptLine(line)}
                    title={`Page ${line.pageNumber}`}
                  >
                    <span>p{line.pageNumber}{line.section !== "body" ? ` ${line.section}` : ""}</span>
                    <p>{line.text}</p>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="selectedBox">
            <FileText size={18} />
            <p>{selectedText || "Text select karo, ya neeche question likho."}</p>
          </div>

          <div className="voicePicker">
            <Volume2 size={17} />
            <select value={selectedVoiceURI} onChange={(event) => handleVoiceChange(event.target.value)}>
              {voices.length ? voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              )) : <option>System voice</option>}
            </select>
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
      {readerMenu && (
        <ReaderMenu
          menu={readerMenu}
          onReadFromHere={readFromMenuPosition}
          onSearch={searchMenuText}
          onCopy={copyMenuText}
          onExplain={explainMenuText}
          onTranslate={translateMenuText}
          onBookmark={bookmarkMenuPosition}
          onClose={() => setReaderMenu(null)}
        />
      )}
    </main>
  );
}

function PdfViewer({ page, loading, activeWordId, activeLine, onWordClick }) {
  if (!page || loading) return <div className="pdfEmpty">PDF page loading...</div>;

  return (
    <div className="pdfScroll">
      <PdfPage
        key={page.pageNumber}
        page={page}
        activeWordId={activeWordId}
        onWordClick={onWordClick}
      />
    </div>
  );
}

function PdfPage({ page, activeWordId, onWordClick }) {
  const canvasRef = useRef(null);
  const inkCanvasRef = useRef(null);
  const wordsById = useMemo(
    () => new Map(page.words.map((word) => [word.id, word])),
    [page.words]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    const renderTask = page.page.render({
      canvasContext: context,
      viewport: page.viewport
    });
    return () => renderTask.cancel();
  }, [page]);

  useEffect(() => {
    const canvas = inkCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";

    page.words.forEach((word) => {
      const active = word.id === activeWordId;
      if (!active) return;
      const y = Math.max(1, Math.min(page.height - 2, word.y + word.height - 1));
      const x1 = Math.max(0, word.x);
      const x2 = Math.min(page.width, word.x + word.width);

      context.fillStyle = "rgba(255, 205, 94, 0.34)";
      context.fillRect(word.x - 1, word.y - 1, word.width + 2, word.height + 2);

      context.beginPath();
      context.strokeStyle = "#d64c3f";
      context.lineWidth = 4;
      context.moveTo(x1, y);
      context.lineTo(x2, y);
      context.stroke();
    });
  }, [activeWordId, page]);

  return (
    <article className="pdfPage" style={{ width: page.width, height: page.height }}>
      <canvas ref={canvasRef} width={page.width} height={page.height} />
      <canvas className="pdfInkLayer" ref={inkCanvasRef} width={page.width} height={page.height} />
      <div
        className="pdfTextLayer"
        onPointerDown={(event) => {
          const button = event.target.closest(".pdfWord");
          if (!button) return;
          const word = wordsById.get(button.dataset.wordId);
          if (word) onWordClick(word, event);
        }}
      >
        {page.words.map((word) => {
          const active = word.id === activeWordId;
          return (
            <React.Fragment key={word.id}>
              <div
                className={active ? "pdfUnderline active" : "pdfUnderline"}
                style={{
                  left: word.x,
                  top: word.y + word.height - 2,
                  width: word.width,
                  height: active ? 5 : 3
                }}
              />
              <button
                className={active ? "pdfWord active" : "pdfWord"}
                data-word-id={word.id}
                style={{
                  left: word.x,
                  top: word.y,
                  width: word.width,
                  height: word.height,
                  fontSize: word.fontSize
                }}
                title={word.text}
              >
                {word.text}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </article>
  );
}

function ReaderMenu({ menu, onReadFromHere, onSearch, onCopy, onExplain, onTranslate, onBookmark, onClose }) {
  return (
    <div className="readerMenu" style={{ left: menu.x, top: menu.y }} role="menu">
      <div className="readerMenuText">
        <strong>p{menu.pageNumber}</strong>
        <span>{menu.word?.text || menu.text}</span>
      </div>
      <button onClick={onReadFromHere}>Read From Here</button>
      <button onClick={onSearch}>Search This Word</button>
      <button onClick={onCopy}>Copy Text</button>
      <button onClick={onExplain}>Explain with AI</button>
      <button onClick={onTranslate}>Translate</button>
      <button onClick={onBookmark}>Bookmark Position</button>
      <button className="readerMenuClose" onClick={onClose}>Close</button>
    </div>
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
