import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { fetchJson, runBackgroundJob } from "../lib/api";
import type { RosterChanges, RosterRow } from "../types";

interface Props {
  onDataChanged: () => void;
}

export function RosterPanel({ onDataChanged }: Props) {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [changes, setChanges] = useState<RosterChanges | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState<"active" | "departed" | "all">(
    "active"
  );
  const [viewMode, setViewMode] = useState<"table" | "markdown">("table");
  const [showChanges, setShowChanges] = useState(true);

  async function loadRoster() {
    setLoading(true);
    try {
      const data = await fetchJson<{
        rows?: RosterRow[];
        changes?: RosterChanges | null;
        markdown?: string;
      }>("/api/roster");
      setRows(data.rows || []);
      setChanges(data.changes || null);
      setMarkdown(data.markdown || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRoster();
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    setLogs([]);
    try {
      const data = await runBackgroundJob<{ logs?: string[] }>(
        "/api/roster/refresh",
        {},
        (liveLogs) => setLogs([...liveLogs])
      );
      setLogs(data.logs || []);
      await loadRoster();
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  const boards = useMemo(() => {
    const set = new Set(rows.map((r) => r.body));
    return Array.from(set).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (selectedBoard !== "ALL" && r.body !== selectedBoard) return false;
      if (q) {
        const hay = `${r.name} ${r.body} ${r.role} ${r.seat}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, statusFilter, selectedBoard, query]);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#14213d]">
              Swampscott Boards &amp; Committees Roster
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Maintained from{" "}
              <a
                href="https://www.swampscottma.gov/sitemap"
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 underline"
              >
                swampscottma.gov/sitemap
              </a>{" "}
              (roster.csv &amp; roster.md). Used as spelling and role context in
              weekly digests.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-stone-300 bg-stone-50 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`rounded px-2.5 py-1 font-medium ${
                  viewMode === "table"
                    ? "bg-white text-[#14213d] shadow-xs"
                    : "text-stone-600"
                }`}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setViewMode("markdown")}
                className={`rounded px-2.5 py-1 font-medium ${
                  viewMode === "markdown"
                    ? "bg-white text-[#14213d] shadow-xs"
                    : "text-stone-600"
                }`}
              >
                roster.md
              </button>
            </div>

            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-md bg-[#14213d] px-4 py-2 text-sm font-medium text-white hover:bg-[#1e3056] disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {refreshing ? "Scraping town site..." : "Refresh Roster"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {logs.length > 0 && (
          <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Scrape Log
            </div>
            <pre className="max-h-40 overflow-auto font-mono text-xs text-stone-700">
              {logs.join("\n")}
            </pre>
          </div>
        )}
      </section>

      {changes && (
        <section className="rounded-lg border border-stone-300 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-[#14213d]">
              Latest Roster Capture ({changes.date}
              {changes.initial ? " · initial baseline" : ""}) —{" "}
              {changes.changes.length} recorded entries
            </div>
            <button
              type="button"
              onClick={() => setShowChanges((v) => !v)}
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              {showChanges ? "Hide details" : "Show details"}
            </button>
          </div>
          {showChanges && (
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Changes ({changes.changes.length})
                </div>
                <ul className="mt-1.5 max-h-48 space-y-1 overflow-auto text-xs text-stone-700">
                  {changes.changes.length === 0 ? (
                    <li className="text-stone-500">No changes recorded.</li>
                  ) : (
                    changes.changes.map((c, idx) => (
                      <li key={idx} className="border-b border-stone-100 py-1">
                        {c}
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Pages Without Parsable Roster ({changes.no_roster_found.length})
                </div>
                <ul className="mt-1.5 max-h-48 space-y-1 overflow-auto text-xs text-stone-600">
                  {changes.no_roster_found.map((b, idx) => (
                    <li key={idx} className="py-0.5">
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      )}

      {viewMode === "markdown" ? (
        <section className="rounded-lg border border-stone-300 bg-white p-6 shadow-xs">
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-stone-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by member name, board, role, or seat..."
                className="w-full rounded-md border border-stone-300 py-1.5 pr-3 pl-9 text-sm"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedBoard}
                onChange={(e) => setSelectedBoard(e.target.value)}
                className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm"
              >
                <option value="ALL">All Boards ({boards.length})</option>
                {boards.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>

              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as "active" | "departed" | "all")
                }
                className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm"
              >
                <option value="active">Active only</option>
                <option value="departed">Departed only</option>
                <option value="all">All statuses</option>
              </select>

              <span className="text-xs text-stone-500">
                {filtered.length} member{filtered.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-stone-500">
              Loading roster...
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-stone-300 bg-stone-50 text-xs font-semibold uppercase tracking-wide text-stone-600">
                    <th className="px-3 py-2.5">Board / Committee</th>
                    <th className="px-3 py-2.5">Name</th>
                    <th className="px-3 py-2.5">Role</th>
                    <th className="px-3 py-2.5">Seat</th>
                    <th className="px-3 py-2.5">Term Expires</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {filtered.map((r, i) => (
                    <tr key={`${r.body}-${r.name}-${i}`} className="hover:bg-stone-50/80">
                      <td className="px-3 py-2 font-medium text-[#14213d]">
                        {r.body}
                      </td>
                      <td className="px-3 py-2 text-stone-900">{r.name}</td>
                      <td className="px-3 py-2 text-stone-700">{r.role}</td>
                      <td className="px-3 py-2 text-stone-600">{r.seat || "—"}</td>
                      <td className="px-3 py-2 text-stone-600">
                        {r.term_expires || "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                            r.status === "active"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-stone-100 text-stone-600"
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {r.source ? (
                          <a
                            href={r.source}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
                          >
                            Page
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
