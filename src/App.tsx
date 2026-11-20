/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  CheckSquare,
  FileText,
  Landmark,
  Users,
  Video,
} from "lucide-react";
import { DigestPanel } from "./components/DigestPanel";
import { PlanningDocsPanel } from "./components/PlanningDocsPanel";
import { RosterPanel } from "./components/RosterPanel";
import { TranscriptsPanel } from "./components/TranscriptsPanel";
import { VotesPanel } from "./components/VotesPanel";
import { fetchJson } from "./lib/api";
import type { OverviewData } from "./types";

type TabId = "digest" | "roster" | "votes" | "planning" | "transcripts";

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("digest");
  const [overview, setOverview] = useState<OverviewData | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await fetchJson<OverviewData>("/api/overview"));
    } catch {
      // ignore transient startup error
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const tabs: Array<{
    id: TabId;
    label: string;
    icon: typeof FileText;
    badge?: string | number;
  }> = [
    {
      id: "digest",
      label: "Weekly Digest",
      icon: FileText,
      badge: overview?.digestsCount,
    },
    {
      id: "roster",
      label: "Board Roster",
      icon: Users,
      badge: overview?.activeMembersCount,
    },
    {
      id: "votes",
      label: "Vote Tally",
      icon: CheckSquare,
      badge: overview?.votesCount,
    },
    {
      id: "planning",
      label: "Planning Docs",
      icon: BookOpen,
      badge: overview?.planningDocsCount,
    },
    {
      id: "transcripts",
      label: "Transcripts",
      icon: Video,
      badge: overview?.transcriptsCount,
    },
  ];

  return (
    <div className="min-h-screen bg-[#f8f7f4] text-[#1c2430]">
      <header className="border-b border-stone-300 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#14213d] text-white">
                <Landmark className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#14213d]">
                  Swampscott Civic Digest
                </h1>
                <p className="text-xs text-stone-600">
                  Town of Swampscott, MA · Public meetings, boards &amp;
                  committees, planning context, and formal votes
                </p>
              </div>
            </div>

            {overview && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-stone-600">
                <div>
                  <span className="font-semibold text-[#14213d]">
                    {overview.boardsCount}
                  </span>{" "}
                  boards
                </div>
                <div>
                  <span className="font-semibold text-[#14213d]">
                    {overview.activeMembersCount}
                  </span>{" "}
                  active members
                  {overview.rosterLastUpdated
                    ? ` (updated ${overview.rosterLastUpdated})`
                    : ""}
                </div>
                <div>
                  <span className="font-semibold text-[#14213d]">
                    {overview.planningDocsCount}
                  </span>{" "}
                  planning docs
                </div>
              </div>
            )}
          </div>

          <nav className="mt-4 flex flex-wrap gap-1 border-t border-stone-200 pt-3">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition ${
                    isActive
                      ? "bg-[#14213d] text-white"
                      : "text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                  {typeof tab.badge === "number" && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                        isActive
                          ? "bg-white/20 text-white"
                          : "bg-stone-200/80 text-stone-700"
                      }`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {activeTab === "digest" && (
          <DigestPanel onDataChanged={loadOverview} />
        )}
        {activeTab === "roster" && (
          <RosterPanel onDataChanged={loadOverview} />
        )}
        {activeTab === "votes" && <VotesPanel />}
        {activeTab === "planning" && <PlanningDocsPanel />}
        {activeTab === "transcripts" && (
          <TranscriptsPanel onDataChanged={loadOverview} />
        )}
      </main>
    </div>
  );
}
