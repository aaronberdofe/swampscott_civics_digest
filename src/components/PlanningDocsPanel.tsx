import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen } from "lucide-react";
import { fetchJson } from "../lib/api";
import type { PlanningDocInfo } from "../types";

export function PlanningDocsPanel() {
  const [docs, setDocs] = useState<PlanningDocInfo[]>([]);
  const [totalChars, setTotalChars] = useState(0);
  const [budget, setBudget] = useState(200_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<{
      docs?: PlanningDocInfo[];
      totalChars?: number;
      budget?: number;
    }>("/api/planning-docs")
      .then((d) => {
        setDocs(d.docs || []);
        setTotalChars(d.totalChars || 0);
        setBudget(d.budget || 200_000);
        if (d.docs?.length) {
          setSelected(d.docs[0].filename);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const activeDoc =
    docs.find((d) => d.filename === selected) ?? docs[0] ?? null;

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-stone-300 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#14213d]">
              Town Planning Documents (planning_docs/)
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Condensed municipal planning references passed to Gemini for
              identifying relevant goals, strategies, and action IDs.
            </p>
          </div>
          <div className="text-right text-xs text-stone-600">
            <div className="font-mono font-medium">
              {totalChars.toLocaleString()} / {budget.toLocaleString()} chars
            </div>
            <div>PLAN_CHAR_BUDGET usage</div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="py-10 text-center text-sm text-stone-500">
          Loading planning documents...
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
          <div className="rounded-lg border border-stone-300 bg-white p-4 shadow-xs">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-600">
              Documents ({docs.length})
            </h3>
            <ul className="mt-3 space-y-2">
              {docs.map((doc) => {
                const isSelected = activeDoc?.filename === doc.filename;
                return (
                  <li key={doc.filename}>
                    <button
                      type="button"
                      onClick={() => setSelected(doc.filename)}
                      className={`w-full rounded-md p-2.5 text-left transition ${
                        isSelected
                          ? "bg-[#14213d] text-white"
                          : "bg-stone-50 text-stone-800 hover:bg-stone-100"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <BookOpen className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="break-words text-sm font-medium">
                          {doc.filename.replace(/\.md$/i, "").replace(/-/g, " ")}
                        </span>
                      </div>
                      <div
                        className={`mt-1 pl-6 font-mono text-xs ${
                          isSelected ? "text-stone-300" : "text-stone-500"
                        }`}
                      >
                        {doc.charCount.toLocaleString()} chars
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="lg:col-span-3 rounded-lg border border-stone-300 bg-white p-6 shadow-xs">
            {activeDoc ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {activeDoc.content}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="py-10 text-center text-sm text-stone-500">
                No planning documents found.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
