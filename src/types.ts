export interface OverviewData {
  activeMembersCount: number;
  totalRosterRows: number;
  boardsCount: number;
  rosterLastUpdated: string | null;
  recentChangesCount: number;
  digestsCount: number;
  promptsCount: number;
  votesCount: number;
  planningDocsCount: number;
  planningChars: number;
  planningBudget: number;
  transcriptsCount: number;
  seenKeysCount: number;
  hasGeminiKey: boolean;
}

export interface RosterRow {
  body: string;
  name: string;
  role: string;
  seat: string;
  term_expires: string;
  status: string;
  first_seen: string;
  last_seen: string;
  source: string;
}

export interface RosterChanges {
  date: string;
  initial: boolean;
  changes: string[];
  no_roster_found: string[];
}

export interface DigestItem {
  filename: string;
  date: string;
  isPrompt: boolean;
  content: string;
  updatedAt: string;
}

export interface VoteRecord {
  meeting_date: string;
  body: string;
  item: string;
  motion: string;
  result: string;
  yes: string | number | null;
  no: string | number | null;
  abstain: string | number | null;
  source: string;
}

export interface TallyRow {
  body: string;
  total: number;
  passed: number;
  failed: number;
  lastVote: string;
}

export interface PlanningDocInfo {
  filename: string;
  charCount: number;
  included: boolean;
  content: string;
}

export interface TranscriptItem {
  filename: string;
  videoId: string;
  title: string;
  url: string;
  published: string;
  charCount: number;
  content: string;
}

export interface AgendaItem {
  key: string;
  kind: "Agenda" | "Minutes";
  date: string;
  body: string;
  url: string;
}

export interface HistoricalDigestMeta {
  date: string;
  tier: 1 | 2;
  filename: string;
}

export interface SourcesPreview {
  today: string;
  weekStart: string;
  nextStart: string;
  nextEnd: string;
  agendasThisWeek: AgendaItem[];
  upcomingAgendas: AgendaItem[];
  recentMinutes: AgendaItem[];
  historicalDigests?: HistoricalDigestMeta[];
  historicalLookbackDays?: number;
  calendarText: string;
  logs: string[];
}

export interface EmailConfigStatus {
  configured: boolean;
  provider: "smtp" | "brevo" | "resend" | "none";
  recipientHint: string | null;
}

export interface ScheduleConfig {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: string;
  refreshRosterFirst: boolean;
  sendEmailAfterRun: boolean;
  lastScheduledDate: string | null;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "done" | "error";
  lastRunMessage: string | null;
}

export interface ScheduleStatusResponse {
  schedule: ScheduleConfig;
  nextRunDate: string;
  nextRunDisplay: string;
  email: EmailConfigStatus;
  rssPath: string;
  cronSecretConfigured: boolean;
}
