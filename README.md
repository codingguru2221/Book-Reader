# Book Reader AI

API-based book reader prototype for reading, listening, explaining words/lines, and searching Wikipedia or Google.

PDF uploads render as real pages with clickable word underlines, synchronized voice playback, and a transcript panel.
Use the sparkle voice button for AI-teacher narration: it rewrites the selected passage into natural Hinglish explanation before speaking it.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Frontend: `http://localhost:5173`  
Backend: `http://localhost:8787`

## API Keys

Set these in `.env`:

```env
GEMINI_API_KEY=your_gemini_key
GOOGLE_SEARCH_API_KEY=your_google_search_key
GOOGLE_SEARCH_CX=your_programmable_search_engine_id
```

Without keys, the app runs in demo mode so the UI can still be tested.
