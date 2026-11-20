import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Search } from "lucide-react";
import { fetchJson } from "../lib/api";
import type { TallyRow, VoteRecord } from "../types";

export function VotesPanel() {
  const [votes, setVotes] = useState<VoteRecord[]>([]);
  const [tally, setTally] = useState<TallyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [bodyFilter, setBodyFilter] = useState("ALL");

  useEffect(() => {
    fetchJson<{ votes?: VoteRecord[]; tally?: TallyRow[] }>("/api/votes")
      .then((d) => {
        setVotes(d.votes || []);
        setTally(d.tally || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const bodies = useMemo(() => {
    return Array.from(new Set(votes.map((v) => v.body))).sort();
  }, [votes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...votes]
      .reverse()
      .filter((v) => {
        if (bodyFilter !== "ALL" && v.body !== bodyFilter) return false;
        if (q) {
          const hay = `${v.body} ${v.item} ${v.motion} ${v.result}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [votes, bodyFilter, query]);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#14213d]">
              Running Vote Tally by Board / Committee
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Formal votes extracted from weekly digests and persisted to{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">
                votes.csv
              </code>
              .
            </p>
          </div>
          <a
            href="/api/votes/csv"
            className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-stone-50 px-3.5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            <Download className="h-4 w-4" />
            Download votes.csv
          </a>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-stone-500">
            Loading vote tally...
          </div>
        ) : tally.length === 0 ? (
          <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-6 text-center text-sm text-stone-500">
            No votes recorded yet. Run a Weekly Digest (with Dry Run unchecked) to
            populate formal votes.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-stone-300 bg-stone-50 text-xs font-semibold uppercase tracking-wide text-stone-600">
                  <th className="px-3 py-2.5">Board / Committee</th>
                  <th className="px-3 py-2.5">Total Votes</th>
                  <th className="px-3 py-2.5">Passed</th>
                  <th className="px-3 py-2.5">Failed</th>
                  <th className="px-3 py-2.5">Last Vote</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200">
                {tally.map((row) => (
                  <tr key={row.body} className="hover:bg-stone-50">
                    <td className="px-3 py-2 font-medium text-[#14213d]">
                      {row.body}
                    </td>
                    <td className="px-3 py-2">{row.total}</td>
                    <td className="px-3 py-2 text-emerald-700">{row.passed}</td>
                    <td className="px-3 py-2 text-red-700">{row.failed}</td>
                    <td className="px-3 py-2 text-stone-600">{row.lastVote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold text-[#14213d]">
            Individual Vote Log ({filtered.length})
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-stone-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter motions or items..."
                className="rounded-md border border-stone-300 py-1.5 pr-3 pl-8 text-sm"
              />
            </div>
            <select
              value={bodyFilter}
              onChange={(e) => setBodyFilter(e.target.value)}
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="ALL">All Boards</option>
              {bodies.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-stone-500">
            No matching vote records.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-stone-300 bg-stone-50 text-xs font-semibold uppercase tracking-wide text-stone-600">
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Board</th>
                  <th className="px-3 py-2.5">Item &amp; Motion</th>
                  <th className="px-3 py-2.5">Result</th>
                  <th className="px-3 py-2.5">Y / N / A</th>
                  <th className="px-3 py-2.5">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200">
                {filtered.map((v, idx) => (
                  <tr key={`${v.meeting_date}-${v.body}-${idx}`} className="hover:bg-stone-50">
                    <td className="whitespace-nowrap px-3 py-2 text-stone-700">
                      {v.meeting_date}
                    </td>
                    <td className="px-3 py-2 font-medium text-[#14213d]">
                      {v.body}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-stone-900">{v.item}</div>
                      <div className="text-xs text-stone-600">{v.motion}</div>
                    </td>
                    <td className="px-3 py-2 capitalize">{v.result}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-stone-600">
                      {v.yes ?? "–"} / {v.no ?? "–"} / {v.abstain ?? "–"}
                    </td>
                    <td className="px-3 py-2">
                      {v.source ? (
                        <a
                          href={v.source}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
                        >
                          Link <ExternalLink className="h-3 w-3" />
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
    </div>
  );
}
