import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Calendar,
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  History,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  Rss,
} from "lucide-react";
import { fetchJson, runBackgroundJob } from "../lib/api";
import type { DigestItem, ScheduleStatusResponse, SourcesPreview } from "../types";

interface Props {
  onDataChanged: () => void;
}

export function DigestPanel({ onDataChanged }: Props) {
  const [dateOverride, setDateOverride] = useState(
    () => new Date().toISOString().slice(0, 10)
  );
  const [dryRun, setDryRun] = useState(false);
  const [ignoreState, setIgnoreState] = useState(false);
  const [promptOnly, setPromptOnly] = useState(false);
  const [skipYtFetch, setSkipYtFetch] = useState(false);

  const [showBackfill, setShowBackfill] = useState(false);
  const [backfillEndDate, setBackfillEndDate] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [backfillLookbackDays, setBackfillLookbackDays] = useState(365);
  const [backfillRecentWeeks, setBackfillRecentWeeks] = useState(8);
  const [backfillOverwrite, setBackfillOverwrite] = useState(false);
  const [backfillDryRun, setBackfillDryRun] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleData, setScheduleData] = useState<ScheduleStatusResponse | null>(null);
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [rssCopied, setRssCopied] = useState(false);

  const [digests, setDigests] = useState<DigestItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SourcesPreview | null>(null);
  const [runLogs, setRunLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadScheduleStatus() {
    const data = await fetchJson<ScheduleStatusResponse>("/api/schedule");
    setScheduleData(data);
  }

  async function loadDigests(selectLatest = false) {
    const data = await fetchJson<{ digests: DigestItem[] }>("/api/digests");
    setDigests(data.digests);
    if (selectLatest && data.digests.length > 0) {
      setSelectedFile(data.digests[0].filename);
    } else if (!selectedFile && data.digests.length > 0) {
      setSelectedFile(data.digests[0].filename);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("digest");
    loadDigests(true)
      .then(() => {
        if (requested) setSelectedFile(requested);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    loadScheduleStatus().catch(() => {
      // non-fatal
    });
  }, []);

  async function handleRunDigest() {
    setRunning(true);
    setError(null);
    setRunLogs([]);
    try {
      const data = await runBackgroundJob<{
        outFile?: string;
        logs?: string[];
      }>(
        "/api/digest/run",
        {
          date: dateOverride,
          dryRun,
          ignoreState,
          promptOnly,
          skipYtFetch,
        },
        (logs) => setRunLogs([...logs])
      );
      setRunLogs(data.logs || []);
      await loadDigests(false);
      if (data.outFile) {
        const fname = String(data.outFile).replace(/^digests\//, "");
        setSelectedFile(fname);
      }
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function handlePreviewSources() {
    setPreviewing(true);
    setError(null);
    try {
      const q = dateOverride ? `?date=${encodeURIComponent(dateOverride)}` : "";
      const data = await fetchJson<SourcesPreview>(`/api/sources/preview${q}`);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleRunBackfill() {
    setBackfilling(true);
    setError(null);
    setRunLogs([]);
    try {
      const data = await runBackgroundJob<{
        logs?: string[];
      }>(
        "/api/digest/backfill",
        {
          endDate: backfillEndDate,
          lookbackDays: backfillLookbackDays,
          recentWeeks: backfillRecentWeeks,
          overwrite: backfillOverwrite,
          dryRun: backfillDryRun,
        },
        (logs) => setRunLogs([...logs])
      );
      setRunLogs(data.logs || []);
      await loadDigests(false);
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackfilling(false);
    }
  }

  async function handleToggleSchedule(
    patch: Partial<{
      enabled: boolean;
      refreshRosterFirst: boolean;
      sendEmailAfterRun: boolean;
    }>
  ) {
    try {
      const updated = await fetchJson<ScheduleStatusResponse>("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setScheduleData(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRunFullPipeline() {
    setRunningPipeline(true);
    setError(null);
    setRunLogs([]);
    try {
      const data = await runBackgroundJob<{
        outFile?: string;
        logs?: string[];
      }>(
        "/api/schedule/run-now",
        { date: dateOverride },
        (logs) => setRunLogs([...logs])
      );
      setRunLogs(data.logs || []);
      await loadDigests(false);
      await loadScheduleStatus();
      if (data.outFile) {
        setSelectedFile(String(data.outFile).replace(/^digests\//, ""));
      }
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningPipeline(false);
    }
  }

  async function handleSendEmail(filename?: string) {
    setSendingEmail(true);
    setError(null);
    try {
      const data = await runBackgroundJob<{
        logs?: string[];
      }>(
        "/api/email/send",
        { filename },
        (logs) => setRunLogs([...logs])
      );
      setRunLogs(data.logs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingEmail(false);
    }
  }

  function handleCopyRssUrl() {
    const url = `${window.location.origin}/rss.xml`;
    navigator.clipboard.writeText(url);
    setRssCopied(true);
    setTimeout(() => setRssCopied(false), 1800);
  }

  const activeItem =
    digests.find((d) => d.filename === selectedFile) ?? digests[0] ?? null;

  function handleCopy() {
    if (!activeItem) return;
    navigator.clipboard.writeText(activeItem.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDownload() {
    if (!activeItem) return;
    const blob = new Blob([activeItem.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeItem.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Runner Controls */}
      <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#14213d]">
              Weekly Civic Digest Generator
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Gathers CivicPlus agendas/minutes, Town Calendar RSS, saved/live YouTube
              transcripts, board roster context, town planning documents, and up to 1 year
              of prior digests (two-tier context).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSchedule((v) => !v)}
              disabled={running || backfilling || runningPipeline}
              className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${
                showSchedule
                  ? "border-[#14213d] bg-[#14213d]/5 text-[#14213d]"
                  : "border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100"
              }`}
            >
              <Rss className="h-4 w-4" />
              Schedule &amp; Delivery
            </button>
            <button
              type="button"
              onClick={() => setShowBackfill((v) => !v)}
              disabled={running || backfilling || runningPipeline}
              className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${
                showBackfill
                  ? "border-[#14213d] bg-[#14213d]/5 text-[#14213d]"
                  : "border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100"
              }`}
            >
              <History className="h-4 w-4" />
              Backfill History
            </button>
            <button
              type="button"
              onClick={handlePreviewSources}
              disabled={previewing || running || backfilling || runningPipeline}
              className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-stone-50 px-3.5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              {previewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Preview Live Sources
            </button>
            <button
              type="button"
              onClick={handleRunDigest}
              disabled={running || backfilling || runningPipeline}
              className="inline-flex items-center gap-2 rounded-md bg-[#14213d] px-4 py-2 text-sm font-medium text-white hover:bg-[#1e3056] disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {running
                ? "Running..."
                : promptOnly
                ? "Generate Prompt Only"
                : "Generate Weekly Digest"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-stone-200 pt-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-stone-500">
              Week Ending (--date)
            </span>
            <div className="relative mt-1">
              <Calendar className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-stone-400" />
              <input
                type="date"
                value={dateOverride}
                onChange={(e) => setDateOverride(e.target.value)}
                className="w-full rounded-md border border-stone-300 bg-white py-1.5 pr-2.5 pl-8 text-sm text-stone-800"
              />
            </div>
            {dateOverride && (
              <span className="mt-1 block text-[11px] leading-tight text-stone-500">
                Week:{" "}
                {(() => {
                  const d = new Date(`${dateOverride}T12:00:00Z`);
                  const ws = new Date(d);
                  ws.setUTCDate(ws.getUTCDate() - 7);
                  const ns = new Date(d);
                  ns.setUTCDate(ns.getUTCDate() + 1);
                  const ne = new Date(d);
                  ne.setUTCDate(ne.getUTCDate() + 8);
                  const fmt = (x: Date) => x.toISOString().slice(0, 10);
                  return `${fmt(ws)}–${dateOverride} · Upcoming: ${fmt(ns)}–${fmt(ne)}`;
                })()}
              </span>
            )}
          </label>

          <label className="flex items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50/70 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="mt-0.5 rounded border-stone-300"
            />
            <span>
              <span className="block font-medium text-stone-800">Dry run</span>
              <span className="text-xs text-stone-500">
                Skip saving state &amp; votes.csv
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50/70 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={ignoreState}
              onChange={(e) => setIgnoreState(e.target.checked)}
              className="mt-0.5 rounded border-stone-300"
            />
            <span>
              <span className="block font-medium text-stone-800">Ignore state</span>
              <span className="text-xs text-stone-500">
                Reprocess previously seen items
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50/70 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={promptOnly}
              onChange={(e) => setPromptOnly(e.target.checked)}
              className="mt-0.5 rounded border-stone-300"
            />
            <span>
              <span className="block font-medium text-stone-800">Prompt only</span>
              <span className="text-xs text-stone-500">
                Write prompt file without calling LLM
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50/70 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={skipYtFetch}
              onChange={(e) => setSkipYtFetch(e.target.checked)}
              className="mt-0.5 rounded border-stone-300"
            />
            <span>
              <span className="block font-medium text-stone-800">
                Skip live YouTube
              </span>
              <span className="text-xs text-stone-500">
                Use saved transcripts/ only
              </span>
            </span>
          </label>
        </div>

        {showBackfill && (
          <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-[#14213d]">
                  Hybrid Historical Backfill (Recent Weeks + Monthly Archives)
                </h3>
                <p className="mt-0.5 text-xs text-stone-600">
                  Scrapes Agenda Center once, builds weekly digests for the latest{" "}
                  {backfillRecentWeeks} weeks and monthly digests for older months up to{" "}
                  {backfillLookbackDays} days back, and seeds votes.csv &amp; state.json
                  chronologically.
                </p>
              </div>
              <button
                type="button"
                onClick={handleRunBackfill}
                disabled={backfilling || running}
                className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#14213d] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#1e3056] disabled:opacity-50"
              >
                {backfilling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <History className="h-3.5 w-3.5" />
                )}
                {backfilling ? "Backfilling..." : "Run Hybrid Backfill"}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
                  Backfill Through
                </span>
                <input
                  type="date"
                  value={backfillEndDate}
                  onChange={(e) => setBackfillEndDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-800"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
                  Lookback (Days)
                </span>
                <input
                  type="number"
                  min={14}
                  max={730}
                  value={backfillLookbackDays}
                  onChange={(e) =>
                    setBackfillLookbackDays(Number(e.target.value) || 365)
                  }
                  className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-800"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
                  Recent Weekly Count
                </span>
                <input
                  type="number"
                  min={0}
                  max={26}
                  value={backfillRecentWeeks}
                  onChange={(e) =>
                    setBackfillRecentWeeks(Math.max(0, Number(e.target.value) || 0))
                  }
                  className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-800"
                />
              </label>

              <label className="flex items-start gap-2 rounded-md border border-stone-200 bg-white p-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={backfillOverwrite}
                  onChange={(e) => setBackfillOverwrite(e.target.checked)}
                  className="mt-0.5 rounded border-stone-300"
                />
                <span>
                  <span className="block font-medium text-stone-800">
                    Overwrite existing
                  </span>
                  <span className="text-stone-500">Regenerate saved dates</span>
                </span>
              </label>

              <label className="flex items-start gap-2 rounded-md border border-stone-200 bg-white p-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={backfillDryRun}
                  onChange={(e) => setBackfillDryRun(e.target.checked)}
                  className="mt-0.5 rounded border-stone-300"
                />
                <span>
                  <span className="block font-medium text-stone-800">Dry run</span>
                  <span className="text-stone-500">Plan &amp; count sources only</span>
                </span>
              </label>
            </div>
          </div>
        )}

        {showSchedule && scheduleData && (
          <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[#14213d]">
                  <Clock className="h-4 w-4" />
                  Weekly Friday 6:00 AM ET Automation, RSS &amp; Email
                </h3>
                <p className="mt-0.5 text-xs text-stone-600">
                  Next scheduled run:{" "}
                  <span className="font-medium text-stone-800">
                    {scheduleData.schedule.enabled
                      ? scheduleData.nextRunDisplay
                      : "Paused"}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={handleRunFullPipeline}
                disabled={runningPipeline || running || backfilling}
                className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#14213d] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#1e3056] disabled:opacity-50"
              >
                {runningPipeline ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {runningPipeline ? "Running Pipeline..." : "Run Friday Pipeline Now"}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-md border border-stone-200 bg-white p-3 text-xs space-y-2">
                <div className="font-semibold uppercase tracking-wide text-stone-500">
                  Friday 6:00 AM ET Schedule
                </div>
                <label className="flex items-center gap-2 text-stone-800">
                  <input
                    type="checkbox"
                    checked={scheduleData.schedule.enabled}
                    onChange={(e) =>
                      handleToggleSchedule({ enabled: e.target.checked })
                    }
                    className="rounded border-stone-300"
                  />
                  <span>Enable weekly Friday 6:00 AM ET auto-run</span>
                </label>
                <label className="flex items-center gap-2 text-stone-800">
                  <input
                    type="checkbox"
                    checked={scheduleData.schedule.refreshRosterFirst}
                    onChange={(e) =>
                      handleToggleSchedule({ refreshRosterFirst: e.target.checked })
                    }
                    className="rounded border-stone-300"
                  />
                  <span>Refresh board roster before digest</span>
                </label>
                <label className="flex items-center gap-2 text-stone-800">
                  <input
                    type="checkbox"
                    checked={scheduleData.schedule.sendEmailAfterRun}
                    onChange={(e) =>
                      handleToggleSchedule({ sendEmailAfterRun: e.target.checked })
                    }
                    className="rounded border-stone-300"
                  />
                  <span>Email digest after completion</span>
                </label>
                {scheduleData.schedule.lastRunMessage && (
                  <div className="border-t border-stone-100 pt-1.5 text-[11px] text-stone-500">
                    Last run: {scheduleData.schedule.lastRunMessage}
                  </div>
                )}
              </div>

              <div className="rounded-md border border-stone-200 bg-white p-3 text-xs space-y-2">
                <div className="font-semibold uppercase tracking-wide text-stone-500">
                  Public RSS 2.0 Feed
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-800">
                    {typeof window !== "undefined"
                      ? `${window.location.origin}${scheduleData.rssPath}`
                      : scheduleData.rssPath}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyRssUrl}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-stone-300 px-2 py-1 text-[11px] font-medium text-stone-700 hover:bg-stone-50"
                  >
                    {rssCopied ? (
                      <Check className="h-3 w-3 text-emerald-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {rssCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-stone-500">
                    Auto-updates on every digest &amp; backfill run
                  </span>
                  <a
                    href={scheduleData.rssPath}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline"
                  >
                    Open RSS <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>

              <div className="rounded-md border border-stone-200 bg-white p-3 text-xs space-y-2">
                <div className="font-semibold uppercase tracking-wide text-stone-500">
                  Email Delivery (Free Tier)
                </div>
                {scheduleData.email.configured ? (
                  <div className="space-y-1 text-stone-700">
                    <div className="font-medium text-emerald-700">
                      Configured ({scheduleData.email.provider.toUpperCase()})
                    </div>
                    <div className="text-[11px] text-stone-500">
                      Recipient: {scheduleData.email.recipientHint}
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] leading-relaxed text-stone-600">
                    Configure <code className="font-mono">EMAIL_TO</code> plus{" "}
                    <code className="font-mono">SMTP_USER</code> &amp;{" "}
                    <code className="font-mono">SMTP_PASS</code> (Gmail App Password),{" "}
                    <code className="font-mono">BREVO_API_KEY</code>, or{" "}
                    <code className="font-mono">RESEND_API_KEY</code> in{" "}
                    <strong>Settings &gt; Secrets</strong>.
                  </p>
                )}
                <div className="text-[11px] text-stone-500">
                  Cloud Scheduler / cron:{" "}
                  <code className="font-mono">POST /api/cron/weekly-digest?wait=true</code>
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
            {error}
          </div>
        )}

        {runLogs.length > 0 && (
          <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Execution Log
            </div>
            <pre className="max-h-40 overflow-auto font-mono text-xs leading-relaxed text-stone-700">
              {runLogs.join("\n")}
            </pre>
          </div>
        )}
      </section>

      {/* Live Sources Preview */}
      {preview && (
        <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-[#14213d]">
              Live Sources Snapshot ({preview.weekStart} to {preview.today})
            </h3>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="text-xs text-stone-500 hover:text-stone-800"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                This Week Agendas ({preview.agendasThisWeek.length})
              </div>
              <ul className="mt-2 space-y-1.5 text-xs">
                {preview.agendasThisWeek.length === 0 ? (
                  <li className="text-stone-500">None in this 7-day window.</li>
                ) : (
                  preview.agendasThisWeek.map((a) => (
                    <li key={a.key} className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-stone-800">
                        {a.date} · {a.body}
                      </span>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-blue-700 hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Upcoming Agendas ({preview.upcomingAgendas.length})
              </div>
              <ul className="mt-2 space-y-1.5 text-xs">
                {preview.upcomingAgendas.length === 0 ? (
                  <li className="text-stone-500">None posted for next week yet.</li>
                ) : (
                  preview.upcomingAgendas.map((a) => (
                    <li key={a.key} className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-stone-800">
                        {a.date} · {a.body}
                      </span>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-blue-700 hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Recent Minutes (60d) ({preview.recentMinutes.length})
              </div>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-auto text-xs">
                {preview.recentMinutes.length === 0 ? (
                  <li className="text-stone-500">No minutes found in window.</li>
                ) : (
                  preview.recentMinutes.map((a) => (
                    <li key={a.key} className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-stone-800">
                        {a.date} · {a.body}
                      </span>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-blue-700 hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Prior Digests ({preview.historicalLookbackDays ?? 365}d) (
                {preview.historicalDigests?.length ?? 0})
              </div>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-auto text-xs">
                {!preview.historicalDigests || preview.historicalDigests.length === 0 ? (
                  <li className="text-stone-500">No prior digests in window.</li>
                ) : (
                  preview.historicalDigests.map((h) => (
                    <li key={h.filename} className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-stone-800">
                        {h.filename}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          h.tier === 1
                            ? "bg-blue-100 text-blue-800"
                            : "bg-stone-200 text-stone-700"
                        }`}
                      >
                        {h.tier === 1 ? "Tier 1 · Full" : "Tier 2 · Archive"}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Digests Archive & Viewer */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="rounded-lg border border-stone-300 bg-white p-4 shadow-xs">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-600">
            Generated Files ({digests.length})
          </h3>
          {digests.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">
              No digests generated yet. Click <strong>Generate Weekly Digest</strong>{" "}
              above to fetch current town records and create your first edition.
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {digests.map((d) => {
                const isSelected = activeItem?.filename === d.filename;
                return (
                  <li key={d.filename}>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(d.filename)}
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition ${
                        isSelected
                          ? "bg-[#14213d] text-white"
                          : "bg-stone-50 text-stone-700 hover:bg-stone-100"
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <FileText className="h-4 w-4 shrink-0" />
                        <span className="truncate font-medium">{d.filename}</span>
                      </span>
                      {d.isPrompt && (
                        <span
                          className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                            isSelected
                              ? "bg-white/20 text-white"
                              : "bg-stone-200 text-stone-700"
                          }`}
                        >
                          Prompt
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="lg:col-span-3 rounded-lg border border-stone-300 bg-white p-6 shadow-xs">
          {!activeItem ? (
            <div className="py-12 text-center text-sm text-stone-500">
              Select or generate a digest to view its contents here.
            </div>
          ) : (
            <div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3">
                <div>
                  <span className="font-mono text-xs text-stone-500">
                    digests/{activeItem.filename}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {!activeItem.isPrompt && (
                    <button
                      type="button"
                      onClick={() => handleSendEmail(activeItem.filename)}
                      disabled={sendingEmail || !scheduleData?.email.configured}
                      title={
                        scheduleData?.email.configured
                          ? `Email ${activeItem.filename} to ${scheduleData.email.recipientHint}`
                          : "Configure EMAIL_TO and SMTP/API key in Settings > Secrets"
                      }
                      className="inline-flex items-center gap-1.5 rounded border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                    >
                      {sendingEmail ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Mail className="h-3.5 w-3.5" />
                      )}
                      {sendingEmail ? "Sending..." : "Email Digest"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 rounded border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="inline-flex items-center gap-1.5 rounded border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </button>
                </div>
              </div>

              {activeItem.isPrompt ? (
                <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-4 font-mono text-xs leading-relaxed text-stone-800">
                  {activeItem.content}
                </pre>
              ) : (
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {activeItem.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
