import { useEffect, useState } from "react";
import { FileText, Loader2, Plus, Video } from "lucide-react";
import { fetchJson, runBackgroundJob } from "../lib/api";
import type { TranscriptItem } from "../types";

interface Props {
  onDataChanged: () => void;
}

export function TranscriptsPanel({ onDataChanged }: Props) {
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [fetchUrlInput, setFetchUrlInput] = useState("");
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [published, setPublished] = useState(
    () => new Date().toISOString().slice(0, 10)
  );
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadTranscripts() {
    setLoading(true);
    try {
      const data = await fetchJson<{ transcripts?: TranscriptItem[] }>(
        "/api/transcripts"
      );
      setTranscripts(data.transcripts || []);
      if (!selected && data.transcripts?.length) {
        setSelected(data.transcripts[0].filename);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTranscripts();
  }, []);

  async function handleFetchLive() {
    setFetching(true);
    setError(null);
    setLogs([]);
    try {
      const data = await runBackgroundJob<{
        logs?: string[];
        transcripts?: TranscriptItem[];
      }>(
        "/api/transcripts/fetch",
        {},
        (liveLogs) => setLogs([...liveLogs])
      );
      setLogs(data.logs || []);
      setTranscripts(data.transcripts || []);
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  async function handleFetchByUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!fetchUrlInput.trim()) return;
    setFetchingUrl(true);
    setError(null);
    setLogs([]);
    try {
      const data = await runBackgroundJob<{
        logs?: string[];
        transcripts?: TranscriptItem[];
        item?: TranscriptItem;
      }>(
        "/api/transcripts/fetch-url",
        { url: fetchUrlInput.trim() },
        (liveLogs) => setLogs([...liveLogs])
      );
      setLogs(data.logs || []);
      setTranscripts(data.transcripts || []);
      if (data.item?.filename) setSelected(data.item.filename);
      setFetchUrlInput("");
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchingUrl(false);
    }
  }

  async function handleAddManual(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const data = await fetchJson<{
        transcripts?: TranscriptItem[];
        item?: TranscriptItem;
      }>("/api/transcripts/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, url, published, text }),
      });
      setTranscripts(data.transcripts || []);
      setSelected(data.item?.filename ?? null);
      setTitle("");
      setUrl("");
      setText("");
      setShowAddForm(false);
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const active =
    transcripts.find((t) => t.filename === selected) ?? transcripts[0] ?? null;

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#14213d]">
              Meeting Transcripts (transcripts/)
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Reads saved transcripts from{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">
                transcripts/
              </code>{" "}
              and optionally fetches captions from{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">
                @townofswampscott/streams
              </code>{" "}
              (note: YouTube often blocks cloud server IPs).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-stone-50 px-3.5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
            >
              <Plus className="h-4 w-4" />
              Add Transcript
            </button>
            <button
              type="button"
              onClick={handleFetchLive}
              disabled={fetching}
              className="inline-flex items-center gap-2 rounded-md bg-[#14213d] px-4 py-2 text-sm font-medium text-white hover:bg-[#1e3056] disabled:opacity-50"
            >
              {fetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Video className="h-4 w-4" />
              )}
              {fetching ? "Fetching..." : "Fetch YouTube Live Transcripts"}
            </button>
          </div>
        </div>

        <form
          onSubmit={handleFetchByUrl}
          className="mt-4 flex flex-col gap-2 border-t border-stone-200 pt-4 sm:flex-row"
        >
          <input
            type="text"
            value={fetchUrlInput}
            onChange={(e) => setFetchUrlInput(e.target.value)}
            placeholder="Fetch specific YouTube video or /live/ URL (e.g. https://www.youtube.com/live/...)"
            className="flex-1 rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={fetchingUrl || !fetchUrlInput.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-stone-300 bg-stone-50 px-3.5 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
          >
            {fetchingUrl && <Loader2 className="h-4 w-4 animate-spin" />}
            {fetchingUrl ? "Extracting..." : "Fetch by URL"}
          </button>
        </form>

        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
            {error}
          </div>
        )}

        {logs.length > 0 && (
          <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              YouTube Fetch Log
            </div>
            <pre className="max-h-40 overflow-auto font-mono text-xs text-stone-700">
              {logs.join("\n")}
            </pre>
          </div>
        )}
      </section>

      {showAddForm && (
        <form
          onSubmit={handleAddManual}
          className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs space-y-4"
        >
          <h3 className="text-base font-semibold text-[#14213d]">
            Save Local Transcript to transcripts/
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium text-stone-600">
                Meeting Title
              </span>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Select Board Meeting"
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-stone-600">
                YouTube URL (optional)
              </span>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-stone-600">
                Published Date
              </span>
              <input
                type="date"
                required
                value={published}
                onChange={(e) => setPublished(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-stone-600">
              Transcript Text
            </span>
            <textarea
              required
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste meeting auto-captions or transcript text..."
              className="mt-1 w-full rounded-md border border-stone-300 p-3 text-sm"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded-md border border-stone-300 px-3.5 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-[#14213d] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#1e3056] disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Transcript"}
            </button>
          </div>
        </form>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="rounded-lg border border-stone-300 bg-white p-4 shadow-xs">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-600">
            Saved Transcripts ({transcripts.length})
          </h3>
          {loading ? (
            <p className="mt-3 text-sm text-stone-500">Loading...</p>
          ) : transcripts.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">
              No saved transcripts yet. Fetch from YouTube or add one manually.
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {transcripts.map((t) => {
                const isSelected = active?.filename === t.filename;
                return (
                  <li key={t.filename}>
                    <button
                      type="button"
                      onClick={() => setSelected(t.filename)}
                      className={`w-full rounded-md p-2.5 text-left text-sm transition ${
                        isSelected
                          ? "bg-[#14213d] text-white"
                          : "bg-stone-50 text-stone-800 hover:bg-stone-100"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <FileText className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="truncate font-medium">{t.title}</span>
                      </div>
                      <div
                        className={`mt-1 pl-6 text-xs ${
                          isSelected ? "text-stone-300" : "text-stone-500"
                        }`}
                      >
                        {t.published} · {t.charCount.toLocaleString()} chars
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="lg:col-span-3 rounded-lg border border-stone-300 bg-white p-6 shadow-xs">
          {!active ? (
            <div className="py-12 text-center text-sm text-stone-500">
              Select a transcript to view its text.
            </div>
          ) : (
            <div>
              <div className="mb-3 border-b border-stone-200 pb-3">
                <h3 className="text-base font-semibold text-[#14213d]">
                  {active.title}
                </h3>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-stone-500">
                  <span>Published: {active.published}</span>
                  <span>File: transcripts/{active.filename}</span>
                  {active.url && active.url.startsWith("http") && (
                    <a
                      href={active.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 underline"
                    >
                      YouTube Link
                    </a>
                  )}
                </div>
              </div>
              <pre className="max-h-[540px] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-stone-800">
                {active.content}
              </pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
