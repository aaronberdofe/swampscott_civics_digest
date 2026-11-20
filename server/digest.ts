import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, MediaResolution, ThinkingLevel } from "@google/genai";
import * as cheerio from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import { XMLParser } from "fast-xml-parser";
import { extractText, getDocumentProxy } from "unpdf";
import { promptContext, recentChanges } from "./roster.ts";

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

export interface DigestRunOptions {
  date?: string;
  promptOnly?: boolean;
  dryRun?: boolean;
  ignoreState?: boolean;
  skipYtFetch?: boolean;
}

export interface DigestItem {
  filename: string;
  date: string;
  isPrompt: boolean;
  content: string;
  updatedAt: string;
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

export interface PlanningDocInfo {
  filename: string;
  charCount: number;
  included: boolean;
  content: string;
}

export interface AgendaItem {
  key: string;
  kind: "Agenda" | "Minutes";
  date: string;
  body: string;
  url: string;
}

const ROOT = process.cwd();
export const PLAN_DIR = path.join(ROOT, "planning_docs");
export const DIGEST_DIR = path.join(ROOT, "digests");
export const TRANSCRIPT_DIR = path.join(ROOT, "transcripts");
export const VOTES_CSV = path.join(ROOT, "votes.csv");
export const STATE_FILE = path.join(ROOT, "state.json");
const OCR_CACHE_DIR = path.join(ROOT, ".ocr_cache");

const CHANNEL_HANDLE = "townofswampscott";
const DEFAULT_CHANNEL_ID = "UCB4NM4epfvYv65PPm4qsaiw";
const AGENDA_CENTER = "https://www.swampscottma.gov/agendacenter";
const CALENDAR_RSS =
  "https://www.swampscottma.gov/RSSFeed.aspx?ModID=58&CID=All-calendar.xml";

const PLAN_CHAR_BUDGET = Number(process.env.PLAN_CHAR_BUDGET || 200_000);
const TRANSCRIPT_CHAR_CAP = Number(process.env.TRANSCRIPT_CHAR_CAP || 150_000);
const DOC_CHAR_CAP = Number(process.env.DOC_CHAR_CAP || 40_000);
const HISTORY_LOOKBACK_DAYS = Number(process.env.HISTORY_LOOKBACK_DAYS || 365);
const HISTORY_RECENT_WEEKS = Number(process.env.HISTORY_RECENT_WEEKS || 4);
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET || 180_000);
const HISTORY_VOTES_CHAR_CAP = Number(process.env.HISTORY_VOTES_CHAR_CAP || 20_000);

const UA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; swampscott-civic-digest/1.0)",
};

const DEFAULT_SKIP_REGEX =
  "varsity|\\bJV\\b|junior varsity|football|soccer|hockey|basketball|baseball|softball|volleyball|lacrosse|swim|\\btrack\\b|cross country|MIAA|wrestling|graduation|commencement";
const SKIP_TITLES = new RegExp(
  process.env.SKIP_TITLE_REGEX || DEFAULT_SKIP_REGEX,
  "i"
);

const VOTE_FIELDS: (keyof VoteRecord)[] = [
  "meeting_date",
  "body",
  "item",
  "motion",
  "result",
  "yes",
  "no",
  "abstain",
  "source",
];

const INSTRUCTIONS = `You are producing a weekly civic summary for residents of Swampscott, Massachusetts.
Use ONLY the material below. Never invent votes, names, numbers or decisions. If a vote count or
outcome is unclear from the sources, say so and leave fields null.
Transcripts are auto-captioned and often misspell names. Use the BOARD/COMMITTEE ROSTER section to
correct spellings and identify roles (e.g. Chair), but only say someone spoke or voted a certain
way if the sources support it.
Use the HISTORICAL CONTEXT sections (recent full digests, 1-year condensed archive, and prior votes
log) ONLY as background to recognize multi-week continuity—such as continued hearings, previously
tabled/deferred items, prior votes, or ongoing projects—and briefly note relevant prior context
where helpful. NEVER report historical meetings as occurring this week, and NEVER include historical
votes from HISTORICAL CONTEXT in this week's final \`\`\`json votes array.

Write Markdown with exactly these sections:

## Meetings this week
For each meeting: board/committee, date, source(s), then 3-8 bullets on what was discussed and any
decisions. Prefer minutes/agenda facts; use transcripts for discussion color; note brief continuity
from prior digests when relevant. Note when only an agenda (no minutes/transcript) was available.

## Connections to town planning documents
Only where genuinely relevant, note how an item relates to the planning documents provided
(name the document and section/goal if identifiable). Skip if nothing connects. Do not force links.

## Coming up next week
List upcoming meetings/events (date, body, notable agenda items) from the upcoming agendas and calendar entries.

Then output a final fenced \`\`\`json block containing an array of every formal vote taken in this
week's meetings (plus newly posted minutes), with objects of the form:
{"meeting_date":"YYYY-MM-DD","body":"","item":"","motion":"","result":"passed|failed|tabled|continued|other",
 "yes":null,"no":null,"abstain":null,"source":"URL"}
Use [] if no formal votes are documented. Voice votes: leave counts null.`;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function isoDateDaysAgo(baseIso: string, days: number): string {
  const d = new Date(`${baseIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoDateDaysAhead(baseIso: string, days: number): string {
  const d = new Date(`${baseIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 45000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...UA_HEADERS, ...(init.headers || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- state
export function loadState(): { seen: string[] } {
  if (!fs.existsSync(STATE_FILE)) return { seen: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return { seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
  } catch {
    return { seen: [] };
  }
}

export function saveState(state: { seen: string[] }): void {
  const unique = Array.from(new Set(state.seen)).sort().slice(-2000);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ seen: unique }, null, 1), "utf-8");
}

// ---------------------------------------------------------------- YouTube
const AGE_RE = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;
const AGE_DAYS: Record<string, number> = {
  second: 0,
  minute: 0,
  hour: 0,
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function resolveChannelId(): string {
  return process.env.CHANNEL_ID || DEFAULT_CHANNEL_ID;
}

function walkObjects(obj: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(obj)) {
    for (const v of obj) walkObjects(v, out);
  } else if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    out.push(rec);
    for (const v of Object.values(rec)) walkObjects(v, out);
  }
  return out;
}

function collectStrings(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === "string") {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectStrings(v, out);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) collectStrings(v, out);
  }
  return out;
}

function parseAgeDays(texts: string[]): number | null {
  for (const t of texts) {
    const m = t.match(AGE_RE);
    if (m) {
      return parseInt(m[1], 10) * (AGE_DAYS[m[2].toLowerCase()] ?? 0);
    }
  }
  return null;
}

export async function fetchLiveTab(
  logs: string[]
): Promise<Map<string, { title: string; ageDays: number | null }> | null> {
  const url = `https://www.youtube.com/@${CHANNEL_HANDLE}/streams`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          Cookie: "CONSENT=YES+1",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      30000
    );
    const html = await res.text();
    const m = html.match(/ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
    if (!m) {
      logs.push("could not read the Live tab (ytInitialData not found)");
      return null;
    }
    const data = JSON.parse(m[1]);
    const found = new Map<string, { title: string; ageDays: number | null }>();

    for (const d of walkObjects(data)) {
      let vid: string | null = null;
      let title: string | null = null;

      if (
        typeof d.videoId === "string" &&
        "title" in d &&
        ("thumbnail" in d || "publishedTimeText" in d)
      ) {
        vid = d.videoId;
        const t = d.title as Record<string, unknown> | string;
        if (typeof t === "string") {
          title = t;
        } else if (t && typeof t === "object") {
          if (typeof t.simpleText === "string") {
            title = t.simpleText;
          } else if (Array.isArray(t.runs)) {
            title = t.runs
              .map((r) => (r && typeof r === "object" ? String((r as { text?: string }).text ?? "") : ""))
              .join("");
          }
        }
      } else if (
        d.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" &&
        typeof d.contentId === "string"
      ) {
        vid = d.contentId;
        try {
          const meta = d.metadata as Record<string, unknown>;
          const lockup = meta?.lockupMetadataViewModel as Record<string, unknown>;
          const titleObj = lockup?.title as Record<string, unknown>;
          if (typeof titleObj?.content === "string") {
            title = titleObj.content;
          }
        } catch {
          title = null;
        }
      }

      if (vid && !found.has(vid)) {
        found.set(vid, {
          title: title || `Live stream ${vid}`,
          ageDays: parseAgeDays(collectStrings(d)),
        });
      }
    }

    if (!found.size) {
      logs.push(
        "Live tab loaded but no videos were recognized (YouTube page layout may have changed)"
      );
      return null;
    }
    return found;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`could not read the Live tab (${msg})`);
    return null;
  }
}

interface VideoEntry {
  id: string;
  title: string;
  published: string;
  url: string;
}

const MONTH_MAP: Record<string, string> = {
  january: "01", jan: "01",
  february: "02", feb: "02",
  march: "03", mar: "03",
  april: "04", apr: "04",
  may: "05",
  june: "06", jun: "06",
  july: "07", jul: "07",
  august: "08", aug: "08",
  september: "09", sep: "09", sept: "09",
  october: "10", oct: "10",
  november: "11", nov: "11",
  december: "12", dec: "12",
};

export function parseTitleDate(title: string): string | null {
  const m1 = title.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (m1) {
    const mm = MONTH_MAP[m1[1].toLowerCase()];
    const dd = m1[2].padStart(2, "0");
    if (mm) return `${m1[3]}-${mm}-${dd}`;
  }
  const m2 = title.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m2) {
    return `${m2[3]}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  }
  const m3 = title.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m3) return m3[0];
  return null;
}

export function extractYoutubeId(input: string): string | null {
  const m = input
    .trim()
    .match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) return input.trim();
  return null;
}

export async function recentVideos(
  today: string,
  logs: string[],
  maxAgeDays = 14,
  liveOnly = true
): Promise<VideoEntry[]> {
  const cid = resolveChannelId();
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`;
  const cutoff = isoDateDaysAgo(today, maxAgeDays);
  const byId = new Map<string, VideoEntry>();

  try {
    const res = await fetchWithTimeout(rssUrl, {}, 25000);
    if (res.ok) {
      const xml = await res.text();
      const parsed = xmlParser.parse(xml);
      const rawEntries = parsed?.feed?.entry;
      const entries = Array.isArray(rawEntries)
        ? rawEntries
        : rawEntries
        ? [rawEntries]
        : [];
      for (const e of entries) {
        const id = e["yt:videoId"];
        const title = typeof e.title === "string" ? e.title : String(e.title ?? "");
        const rssPub = typeof e.published === "string" ? e.published.slice(0, 10) : "";
        const titleDate = parseTitleDate(title);
        const pub = titleDate || rssPub;
        const linkHref = Array.isArray(e.link)
          ? e.link[0]?.["@_href"]
          : e.link?.["@_href"];
        if (id && pub) {
          byId.set(String(id), {
            id: String(id),
            title,
            published: pub,
            url: linkHref || `https://www.youtube.com/watch?v=${id}`,
          });
        }
      }
    }
  } catch (err) {
    logs.push(`YouTube RSS fetch warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!liveOnly || process.env.LIVE_ONLY === "0") {
    return Array.from(byId.values()).filter(
      (v) => v.published >= cutoff && v.published <= today
    );
  }

  const live = await fetchLiveTab(logs);
  if (!live) {
    logs.push(
      "Live tab unavailable; returning no videos rather than including non-live uploads."
    );
    return [];
  }

  const out: VideoEntry[] = [];
  for (const [vid, info] of live.entries()) {
    // Scheduled upcoming streams have no "Streamed X ago" timestamp yet
    if (info.ageDays === null) {
      continue;
    }
    let v = byId.get(vid);
    const titleDate = parseTitleDate(info.title);
    if (!v) {
      v = {
        id: vid,
        title: info.title,
        published: titleDate || isoDateDaysAgo(today, info.ageDays),
        url: `https://www.youtube.com/watch?v=${vid}`,
      };
    } else if (titleDate) {
      v = { ...v, published: titleDate };
    }
    if (v.published >= cutoff && v.published <= today) {
      out.push(v);
    }
  }
  logs.push(
    `Live tab: ${live.size} videos, ${out.length} within ${cutoff}..${today}`
  );
  return out;
}

export async function getTranscript(
  videoId: string,
  logs: string[]
): Promise<string | null> {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetchWithTimeout(
      watchUrl,
      {
        headers: {
          Cookie: "CONSENT=YES+1",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      25000
    );
    if (!res.ok) {
      logs.push(
        `  transcript unavailable for ${videoId}: HTTP ${res.status} (YouTube often blocks cloud IPs)`
      );
      return null;
    }
    const html = await res.text();
    const match = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.*?\});\s*(?:var|const|let|<\/script>)/s
    );
    if (!match) {
      logs.push(
        `  transcript unavailable for ${videoId}: player response missing (YouTube often blocks cloud IPs)`
      );
      return null;
    }
    const player = JSON.parse(match[1]);
    const playStatus = player?.playabilityStatus?.status;
    if (playStatus && playStatus !== "OK") {
      const reason = player?.playabilityStatus?.reason || playStatus;
      logs.push(
        `  YouTube blocked direct captions for ${videoId}: ${reason}`
      );
      return null;
    }
    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) {
      logs.push(`  transcript unavailable for ${videoId}: no caption tracks`);
      return null;
    }
    const track =
      tracks.find((t: { languageCode?: string }) =>
        String(t.languageCode || "").startsWith("en")
      ) || tracks[0];
    const baseUrl = track?.baseUrl;
    if (!baseUrl) return null;

    const capRes = await fetchWithTimeout(`${baseUrl}&fmt=json3`, {}, 25000);
    if (!capRes.ok) return null;
    const json3 = (await capRes.json()) as {
      events?: Array<{ segs?: Array<{ utf8?: string }> }>;
    };
    const parts: string[] = [];
    for (const ev of json3.events || []) {
      if (!Array.isArray(ev.segs)) continue;
      for (const seg of ev.segs) {
        if (seg.utf8 && seg.utf8.trim()) {
          parts.push(seg.utf8.replace(/\n+/g, " ").trim());
        }
      }
    }
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    return joined || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(
      `  transcript unavailable for ${videoId}: ${msg} (YouTube often blocks cloud IPs)`
    );
    return null;
  }
}

export async function transcribeYoutubeWithGemini(
  video: { id: string; title: string; published: string; url: string },
  logs: string[]
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const envModel = process.env.GEMINI_MODEL?.trim();
  const models = Array.from(
    new Set([...(envModel ? [envModel] : []), "gemini-4-hydrogen", "gemini-3.1-flash-lite"])
  );

  for (const model of models) {
    try {
      logs.push(`  trying Gemini video fallback (${model}) for ${video.id}...`);
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            fileData: {
              fileUri: video.url,
            },
            videoMetadata: {
              fps: 0.1,
            },
          },
          {
            text: `Transcribe and create a detailed, factual chronological meeting record from this Town of Swampscott public meeting video: "${video.title}" (${video.published}). Capture who speaks (where stated or shown), each agenda item discussed, public comments, exact motions, who moved/seconded, and formal vote outcomes/counts. Use only what is spoken or shown in the video; do not invent anything.`,
          },
        ],
        config: {
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });
      const text = (response.text ?? "").trim();
      if (text) {
        logs.push(
          `  Gemini video fallback succeeded (${model}): ${text.length.toLocaleString()} chars`
        );
        return text;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`  Gemini video fallback (${model}) failed for ${video.id}: ${msg}`);
    }
  }
  return null;
}

export async function resolveVideoTranscript(
  video: VideoEntry,
  logs: string[],
  allowGeminiFallback = true
): Promise<string | null> {
  const direct = await getTranscript(video.id, logs);
  if (direct) return direct;
  if (allowGeminiFallback) {
    return await transcribeYoutubeWithGemini(video, logs);
  }
  return null;
}

export function listSavedTranscripts(): TranscriptItem[] {
  if (!fs.existsSync(TRANSCRIPT_DIR)) return [];
  const files = fs
    .readdirSync(TRANSCRIPT_DIR)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .reverse();

  const items: TranscriptItem[] = [];
  for (const filename of files) {
    const raw = fs.readFileSync(path.join(TRANSCRIPT_DIR, filename), "utf-8");
    const sepIdx = raw.indexOf("\n\n");
    const head = sepIdx === -1 ? raw : raw.slice(0, sepIdx);
    const body = sepIdx === -1 ? "" : raw.slice(sepIdx + 2);
    const meta: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const idx = line.indexOf(": ");
      if (idx !== -1) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 2).trim();
      }
    }
    const stem = filename.replace(/\.txt$/i, "");
    const vid = stem.includes("_") ? stem.split("_").slice(1).join("_") : stem;
    items.push({
      filename,
      videoId: vid,
      title: meta.TITLE || stem,
      url: meta.URL || "",
      published: meta.PUBLISHED || stem.split("_")[0] || "",
      charCount: body.length,
      content: body,
    });
  }
  return items;
}

export function loadSavedTranscriptsMap(
  today: string,
  maxAgeDays = 14
): Map<string, string> {
  const out = new Map<string, string>();
  const cutoff = isoDateDaysAgo(today, maxAgeDays);
  for (const t of listSavedTranscripts()) {
    if (!t.published || t.published < cutoff || t.published > today) continue;
    out.set(
      `yt-${t.videoId}`,
      `=== VIDEO: ${t.title} (posted ${t.published}) ${t.url} ===\n${t.content.slice(
        0,
        TRANSCRIPT_CHAR_CAP
      )}`
    );
  }
  return out;
}

export function saveManualTranscript(input: {
  title: string;
  url?: string;
  published: string;
  text: string;
}): TranscriptItem {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const cleanTitle = input.title.trim() || "Meeting Transcript";
  const pub = /^\d{4}-\d{2}-\d{2}$/.test(input.published)
    ? input.published
    : new Date().toISOString().slice(0, 10);
  const url = (input.url || "").trim();
  const parsedId = url ? extractYoutubeId(url) : null;
  const vid =
    parsedId ||
    cleanTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) ||
    String(Date.now());
  const filename = `${pub}_${vid}.txt`;
  const fileContent = `TITLE: ${cleanTitle}\nURL: ${url || "(local transcript)"}\nPUBLISHED: ${pub}\n\n${input.text.trim()}\n`;
  fs.writeFileSync(path.join(TRANSCRIPT_DIR, filename), fileContent, "utf-8");
  return {
    filename,
    videoId: vid,
    title: cleanTitle,
    url: url || "(local transcript)",
    published: pub,
    charCount: input.text.trim().length,
    content: input.text.trim(),
  };
}

export async function fetchTranscriptByUrl(
  inputUrl: string,
  logs: string[] = []
): Promise<{
  item: TranscriptItem;
  logs: string[];
}> {
  const videoId = extractYoutubeId(inputUrl);
  if (!videoId) {
    throw new Error("Could not extract a valid 11-character YouTube video ID from that URL.");
  }
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let title = `Meeting Video ${videoId}`;
  let published = new Date().toISOString().slice(0, 10);

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      watchUrl
    )}&format=json`;
    const oRes = await fetchWithTimeout(oembedUrl, {}, 15000);
    if (oRes.ok) {
      const oData = (await oRes.json()) as { title?: string };
      if (oData.title && oData.title.trim()) {
        title = oData.title.trim();
        const parsedDate = parseTitleDate(title);
        if (parsedDate) published = parsedDate;
      }
    }
  } catch {
    // fallback to watch page <title> below
  }

  if (title.startsWith("Meeting Video ")) {
    try {
      const res = await fetchWithTimeout(watchUrl, {}, 20000);
      if (res.ok) {
        const html = await res.text();
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
          const candidate = titleMatch[1]
            .replace(/\s*-\s*YouTube\s*$/i, "")
            .trim();
          if (candidate) title = candidate;
        }
        const parsedDate = parseTitleDate(title);
        if (parsedDate) published = parsedDate;
      }
    } catch {
      // ignore metadata fetch failure
    }
  }

  const transcript = await resolveVideoTranscript(
    { id: videoId, title, published, url: watchUrl },
    logs,
    true
  );
  if (!transcript) {
    throw new Error(
      `Could not retrieve captions or generate transcript for ${videoId}. Check the log or paste captions manually.`
    );
  }

  const item = saveManualTranscript({
    title,
    url: watchUrl,
    published,
    text: transcript,
  });
  logs.push(`Saved transcript to transcripts/${item.filename}`);
  return { item, logs };
}

export async function fetchTranscriptsMode(
  dateOverride?: string,
  logs: string[] = []
): Promise<{
  saved: number;
  skipped: number;
  logs: string[];
  transcripts: TranscriptItem[];
}> {
  const today = dateOverride || new Date().toISOString().slice(0, 10);
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  let saved = 0;
  let skipped = 0;

  const videos = await recentVideos(today, logs);
  for (const v of videos) {
    if (SKIP_TITLES.test(v.title)) {
      logs.push(`skip (sports/other): ${v.title}`);
      skipped++;
      continue;
    }
    const existing = listSavedTranscripts().find((t) => t.videoId === v.id);
    if (existing) {
      logs.push(`already saved: ${v.title} (${existing.filename})`);
      continue;
    }
    logs.push(`fetching: ${v.title}`);
    const t = await resolveVideoTranscript(v, logs, true);
    if (t) {
      const target = path.join(TRANSCRIPT_DIR, `${v.published}_${v.id}.txt`);
      fs.writeFileSync(
        target,
        `TITLE: ${v.title}\nURL: ${v.url}\nPUBLISHED: ${v.published}\n\n${t}`,
        "utf-8"
      );
      saved++;
    }
  }
  logs.push(`Saved ${saved} new transcript(s) in transcripts/.`);
  return { saved, skipped, logs, transcripts: listSavedTranscripts() };
}

// ---------------------------------------------------------------- Agenda Center
async function extractPdfWithGemini(
  buf: Buffer,
  url: string,
  logs: string[]
): Promise<string> {
  const cacheKey = crypto.createHash("sha1").update(url).digest("hex");
  const cacheFile = path.join(OCR_CACHE_DIR, `${cacheKey}.txt`);
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, "utf-8").trim();
    if (cached) return cached;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || buf.length > 15 * 1024 * 1024) return "";

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  // Prefer flash-lite for OCR to preserve gemini-4-hydrogen quota for digest synthesis
  const envModel = process.env.GEMINI_MODEL?.trim();
  const models = Array.from(
    new Set(["gemini-3.1-flash-lite", ...(envModel ? [envModel] : []), "gemini-4-hydrogen"])
  );

  for (const model of models) {
    try {
      logs.push(`  scanned PDF detected (${url}); extracting text with ${model}...`);
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: buf.toString("base64"),
            },
          },
          {
            text: "Extract all readable text verbatim from this municipal meeting agenda or minutes PDF. Preserve headings, dates, times, agenda items, names, and motions. Do not summarize or invent anything.",
          },
        ],
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });
      const text = (response.text ?? "").trim();
      if (text) {
        fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, text, "utf-8");
        return text;
      }
    } catch (err) {
      logs.push(
        `  scanned PDF OCR (${model}) failed for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return "";
}

async function extractResponseText(
  res: Response,
  url: string,
  logs: string[],
  allowOcr: boolean
): Promise<string> {
  const contentType = res.headers.get("content-type") || "";
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  const isPdf =
    contentType.toLowerCase().includes("pdf") ||
    buf.subarray(0, 4).toString("ascii") === "%PDF";

  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    if (text && text.trim()) {
      return text;
    }
    if (allowOcr) {
      const ocrText = await extractPdfWithGemini(buf, url, logs);
      if (ocrText.trim()) return ocrText;
    }
    return "[Scanned or image-only PDF; selectable text unavailable — see source link.]";
  }

  const html = buf.toString("utf-8");
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $("body")
    .text()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

export async function scrapeAgendaCenter(
  logs: string[]
): Promise<Map<string, AgendaItem>> {
  const res = await fetchWithTimeout(AGENDA_CENTER, {}, 45000);
  if (!res.ok) {
    throw new Error(`Agenda Center HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = new Map<string, AgendaItem>();

  const nodes = $("h2, a[href]").toArray();
  let currentHeading = "Unknown body";

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    if (tag === "h2") {
      const text = $(node).text().replace(/\s+/g, " ").trim();
      if (text) currentHeading = text;
      continue;
    }
    const href = $(node).attr("href") || "";
    const m = href.match(/\/AgendaCenter\/ViewFile\/(Agenda|Minutes)\/_(\d{8})-(\d+)/);
    if (!m) continue;
    const [, kindRaw, dStr, idStr] = m;
    const kind = kindRaw as "Agenda" | "Minutes";
    const mm = dStr.slice(0, 2);
    const dd = dStr.slice(2, 4);
    const yyyy = dStr.slice(4, 8);
    const isoDate = `${yyyy}-${mm}-${dd}`;
    const resolvedUrl = new URL(href.split("?")[0], AGENDA_CENTER).toString();
    const key = `${kind}-${idStr}`;
    items.set(key, {
      key,
      kind,
      date: isoDate,
      body: currentHeading,
      url: resolvedUrl,
    });
  }

  logs.push(`Agenda Center: found ${items.size} agenda/minutes links`);
  return items;
}

async function fetchDoc(
  url: string,
  logs: string[],
  cap = DOC_CHAR_CAP,
  allowOcr = true
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, {}, 60000);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await extractResponseText(res, url, logs, allowOcr);
    return text.slice(0, cap);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`  could not fetch ${url}: ${msg}`);
    return null;
  }
}

export async function upcomingCalendar(logs: string[]): Promise<string> {
  try {
    const res = await fetchWithTimeout(CALENDAR_RSS, {}, 30000);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const xml = await res.text();
    const parsed = xmlParser.parse(xml);
    const rawItems = parsed?.rss?.channel?.item;
    const items = Array.isArray(rawItems)
      ? rawItems
      : rawItems
      ? [rawItems]
      : [];

    const lines: string[] = [];
    for (const e of items.slice(0, 40)) {
      const title = String(e.title ?? "").trim();
      const rawDesc = String(e.description ?? "");
      const $ = cheerio.load(rawDesc);
      const summ = $.text().replace(/\s+/g, " ").trim().slice(0, 300);
      lines.push(`- ${title} | ${summ}`);
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`calendar feed failed: ${msg}`);
    return "";
  }
}

// ---------------------------------------------------------------- planning docs
export function listPlanningDocs(): {
  docs: PlanningDocInfo[];
  totalChars: number;
  budget: number;
} {
  if (!fs.existsSync(PLAN_DIR)) {
    return { docs: [], totalChars: 0, budget: PLAN_CHAR_BUDGET };
  }
  const includePdfs = process.env.INCLUDE_PDFS === "1";
  const files = fs
    .readdirSync(PLAN_DIR)
    .filter((f) => {
      if (f.toLowerCase() === "readme.md") return false;
      const ext = path.extname(f).toLowerCase();
      return ext === ".md" || ext === ".txt" || (includePdfs && ext === ".pdf");
    })
    .sort();

  const docs: PlanningDocInfo[] = [];
  let used = 0;

  for (const filename of files) {
    const fullPath = path.join(PLAN_DIR, filename);
    if (!fs.statSync(fullPath).isFile()) continue;
    const content = fs.readFileSync(fullPath, "utf-8");
    const room = PLAN_CHAR_BUDGET - used;
    const included = room > 0;
    if (included) {
      used += Math.min(content.length, room);
    }
    docs.push({
      filename,
      charCount: content.length,
      included,
      content,
    });
  }

  return { docs, totalChars: used, budget: PLAN_CHAR_BUDGET };
}

export async function loadPlanningDocs(logs: string[]): Promise<string> {
  if (!fs.existsSync(PLAN_DIR)) return "";
  const includePdfs = process.env.INCLUDE_PDFS === "1";
  const files = fs
    .readdirSync(PLAN_DIR)
    .filter((f) => {
      if (f.toLowerCase() === "readme.md") return false;
      const ext = path.extname(f).toLowerCase();
      return ext === ".md" || ext === ".txt" || (includePdfs && ext === ".pdf");
    })
    .sort();

  const chunks: string[] = [];
  let used = 0;

  for (const filename of files) {
    const fullPath = path.join(PLAN_DIR, filename);
    if (!fs.statSync(fullPath).isFile()) continue;
    let text = "";
    try {
      if (path.extname(filename).toLowerCase() === ".pdf") {
        const buf = fs.readFileSync(fullPath);
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const extracted = await extractText(pdf, { mergePages: true });
        text = extracted.text || "";
      } else {
        text = fs.readFileSync(fullPath, "utf-8");
      }
    } catch (err) {
      logs.push(
        `skip planning doc ${filename}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    const room = PLAN_CHAR_BUDGET - used;
    if (room <= 0) {
      logs.push(`planning budget exhausted; skipped ${filename}`);
      break;
    }
    const sliced = text.slice(0, room);
    used += sliced.length;
    chunks.push(`=== PLANNING DOC: ${filename} ===\n${sliced}`);
  }

  logs.push(`planning docs: ${chunks.length} file(s), ${used.toLocaleString()} characters`);
  return chunks.join("\n\n");
}

// ---------------------------------------------------------------- historical context (two-tier)
interface DigestSection {
  heading: string;
  body: string;
}

function splitDigestSections(md: string): DigestSection[] {
  const cleaned = md
    .replace(/\n_Auto-generated by an LLM[^\n]*\s*$/i, "")
    .trim();
  const lines = cleaned.split(/\r?\n/);
  const sections: DigestSection[] = [];
  let currentHeading = "";
  let buf: string[] = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (currentHeading || buf.length) {
        sections.push({
          heading: currentHeading,
          body: buf.join("\n").trim(),
        });
      }
      currentHeading = m[1];
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (currentHeading || buf.length) {
    sections.push({
      heading: currentHeading,
      body: buf.join("\n").trim(),
    });
  }
  return sections;
}

function stripTrailingRule(text: string): string {
  return text.replace(/\n---\s*$/g, "").trim();
}

function formatTier1Digest(date: string, content: string): string {
  const sections = splitDigestSections(content);
  const kept = sections.filter((s) => {
    const h = s.heading.toLowerCase();
    return (
      h.includes("meetings this week") ||
      h.includes("connections to town planning") ||
      h.includes("membership changes")
    );
  });

  const body = kept.length
    ? kept
        .map((s) => `## ${s.heading}\n${stripTrailingRule(s.body)}`)
        .join("\n\n")
    : stripTrailingRule(content.replace(/^#\s+[^\n]*\n+/, ""));

  return `=== PRIOR DIGEST (Tier 1 recent — week ending ${date}) ===\n${body.trim()}`;
}

function formatTier2Digest(date: string, content: string): string {
  const sections = splitDigestSections(content);
  const meetings = sections.find((s) => {
    const h = s.heading.toLowerCase();
    return h.includes("meetings this week") || h.includes("meetings this month");
  });
  let body = meetings
    ? stripTrailingRule(meetings.body)
    : stripTrailingRule(
        sections
          .filter((s) => {
            const h = s.heading.toLowerCase();
            return (
              h &&
              !h.includes("coming up") &&
              !h.includes("running vote tally")
            );
          })
          .map((s) => `## ${s.heading}\n${s.body}`)
          .join("\n\n")
      );

  // Condense links and boilerplate in Tier 2 so up to 48 older weeks fit cleanly
  body = body
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/^\s*\*\([^)]*only an agenda[^)]*\)\*\s*$/gim, "")
    .replace(/^\s*\*\s*\*\*Source\(s\)?:?\*\*[^\n]*$/gim, "")
    .replace(/^\s*[-*]\s*\*\*Status:\*\*\s*Agenda only[^\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return `=== PRIOR DIGEST (Tier 2 archive — week ending ${date}) ===\n${body}`;
}

export interface HistoricalDigestMeta {
  date: string;
  tier: 1 | 2;
  filename: string;
}

export function listHistoricalDigests(today: string): HistoricalDigestMeta[] {
  if (!fs.existsSync(DIGEST_DIR)) return [];
  const cutoff = isoDateDaysAgo(today, HISTORY_LOOKBACK_DAYS);
  const candidates = fs
    .readdirSync(DIGEST_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((filename) => ({
      filename,
      date: filename.replace(/\.md$/, ""),
    }))
    .filter((d) => d.date < today && d.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date));

  return candidates.map((d, idx) => ({
    ...d,
    tier: idx < HISTORY_RECENT_WEEKS ? 1 : 2,
  }));
}

export function loadHistoricalVotesContext(
  weekStart: string,
  cutoff: string
): { text: string; count: number } {
  const prior = loadVotes()
    .filter(
      (r) =>
        r.meeting_date &&
        r.meeting_date < weekStart &&
        r.meeting_date >= cutoff
    )
    .sort((a, b) => (b.meeting_date || "").localeCompare(a.meeting_date || ""));

  if (!prior.length) return { text: "", count: 0 };

  const lines: string[] = [];
  let used = 0;
  let included = 0;
  for (const r of prior) {
    const counts =
      r.yes !== "" && r.yes !== null && r.yes !== undefined
        ? ` (${r.yes}-${r.no ?? 0}-${r.abstain ?? 0})`
        : "";
    const line = `- ${r.meeting_date} | ${r.body} | ${r.item || r.motion} -> ${r.result}${counts}`;
    if (used + line.length + 1 > HISTORY_VOTES_CHAR_CAP) break;
    lines.push(line);
    used += line.length + 1;
    included++;
  }
  return { text: lines.join("\n"), count: included };
}

export function loadHistoricalContext(
  today: string,
  weekStart: string,
  logs: string[]
): {
  tier1Blocks: string[];
  tier2Blocks: string[];
  votesText: string;
  tier1Count: number;
  tier2Count: number;
  votesCount: number;
  totalChars: number;
} {
  const cutoff = isoDateDaysAgo(today, HISTORY_LOOKBACK_DAYS);
  const metas = listHistoricalDigests(today);
  const tier1Metas = metas.filter((m) => m.tier === 1);
  const tier2Metas = metas.filter((m) => m.tier === 2);

  const tier1Blocks: string[] = [];
  const tier2Blocks: string[] = [];
  let remainingBudget = HISTORY_CHAR_BUDGET;

  // Allocate Tier 1 recent full digests (reserve at least 35% of budget for Tier 2 if Tier 2 exists)
  const tier1ReserveLimit = tier2Metas.length
    ? Math.floor(HISTORY_CHAR_BUDGET * 0.65)
    : HISTORY_CHAR_BUDGET;
  let tier1Used = 0;

  for (let i = 0; i < tier1Metas.length; i++) {
    const m = tier1Metas[i];
    const raw = fs.readFileSync(path.join(DIGEST_DIR, m.filename), "utf-8");
    const formatted = formatTier1Digest(m.date, raw);
    const tier1Remaining = tier1ReserveLimit - tier1Used;
    if (tier1Remaining <= 400) break;
    const perItemCap = Math.max(
      400,
      Math.floor(tier1Remaining / (tier1Metas.length - i))
    );
    const chunk =
      formatted.length > perItemCap
        ? `${formatted.slice(0, perItemCap)}\n[...truncated]`
        : formatted;
    tier1Blocks.push(chunk);
    tier1Used += chunk.length;
    remainingBudget -= chunk.length;
  }

  // Allocate Tier 2 condensed archive dynamically across remaining weeks up to 1 year
  for (let i = 0; i < tier2Metas.length; i++) {
    const m = tier2Metas[i];
    if (remainingBudget <= 300) break;
    const raw = fs.readFileSync(path.join(DIGEST_DIR, m.filename), "utf-8");
    const formatted = formatTier2Digest(m.date, raw);
    const perItemCap = Math.max(
      1200,
      Math.floor(remainingBudget / (tier2Metas.length - i))
    );
    const chunk =
      formatted.length > perItemCap
        ? `${formatted.slice(0, perItemCap)}\n[...truncated]`
        : formatted;
    if (chunk.length > remainingBudget) break;
    tier2Blocks.push(chunk);
    remainingBudget -= chunk.length;
  }

  const votesHist = loadHistoricalVotesContext(weekStart, cutoff);
  const totalChars =
    tier1Blocks.reduce((acc, s) => acc + s.length, 0) +
    tier2Blocks.reduce((acc, s) => acc + s.length, 0) +
    votesHist.text.length;

  logs.push(
    `historical context (${HISTORY_LOOKBACK_DAYS}d window): ${tier1Blocks.length} Tier 1 full + ${tier2Blocks.length} Tier 2 condensed digest(s), ${votesHist.count} prior vote(s), ${totalChars.toLocaleString()} chars`
  );

  return {
    tier1Blocks,
    tier2Blocks,
    votesText: votesHist.text,
    tier1Count: tier1Blocks.length,
    tier2Count: tier2Blocks.length,
    votesCount: votesHist.count,
    totalChars,
  };
}

// ---------------------------------------------------------------- prompt & Gemini
function section(title: string, blocks: string[]): string {
  return (
    `\n\n######## ${title} ########\n` +
    (blocks.length ? blocks.join("\n\n") : "(none)")
  );
}

export function buildPrompt(params: {
  plan: string;
  historyTier1: string[];
  historyTier2: string[];
  historyVotes: string;
  transcripts: string[];
  agendas: string[];
  minutes: string[];
  upcoming: string[];
  calendar: string;
  weekStart: string;
  today: string;
  rosterText: string;
}): string {
  return (
    INSTRUCTIONS +
    `\n\nWeek covered: ${params.weekStart} to ${params.today}.` +
    section(
      "BOARD/COMMITTEE ROSTER (current members and roles)",
      params.rosterText ? [params.rosterText] : []
    ) +
    section(
      "PLANNING DOCUMENTS (context only)",
      params.plan ? [params.plan] : []
    ) +
    section(
      `HISTORICAL CONTEXT — TIER 1 (last ${HISTORY_RECENT_WEEKS} weekly digests, full)`,
      params.historyTier1
    ) +
    section(
      `HISTORICAL CONTEXT — TIER 2 (older digests up to ${HISTORY_LOOKBACK_DAYS} days, condensed)`,
      params.historyTier2
    ) +
    section(
      "HISTORICAL CONTEXT — PRIOR FORMAL VOTES LOG (background only; do not re-emit)",
      params.historyVotes ? [params.historyVotes] : []
    ) +
    section("THIS WEEK: VIDEO TRANSCRIPTS", params.transcripts) +
    section("THIS WEEK: AGENDAS", params.agendas) +
    section("NEWLY POSTED MINUTES", params.minutes) +
    section("UPCOMING AGENDAS (next week)", params.upcoming) +
    section(
      "TOWN CALENDAR ENTRIES (best effort, upcoming)",
      params.calendar ? [params.calendar] : []
    )
  );
}

async function callGemini(
  prompt: string,
  logs: string[],
  preferredModels?: string[]
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add it in Settings > Secrets, or run in Prompt-Only mode."
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const envModel = process.env.GEMINI_MODEL?.trim();
  const defaults = preferredModels?.length
    ? preferredModels
    : ["gemini-4-hydrogen", "gemini-3.1-flash-lite"];
  const candidates = [...(envModel ? [envModel] : []), ...defaults];
  const models = Array.from(new Set(candidates));

  let lastError = "No Gemini model succeeded.";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        logs.push(`Summarizing with ${model} (attempt ${attempt + 1})...`);
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
        });
        const text = response.text ?? "";
        if (text.trim()) {
          logs.push(`Summarized successfully with ${model}`);
          return text;
        }
        lastError = `${model}: returned empty response`;
        logs.push(lastError);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = `${model}: ${msg}`;
        logs.push(lastError);
        const transient = /500|503|429|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg);
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      }
    }
  }

  throw new Error(lastError);
}

export function splitVotes(text: string): {
  summary: string;
  votes: VoteRecord[];
} {
  const matches = Array.from(text.matchAll(/```json\s*(\[[\s\S]*?\])\s*```/g));
  if (!matches.length) {
    return { summary: text.trim(), votes: [] };
  }
  const last = matches[matches.length - 1];
  let votes: VoteRecord[] = [];
  try {
    const parsed = JSON.parse(last[1]);
    if (Array.isArray(parsed)) {
      votes = parsed;
    }
  } catch {
    votes = [];
  }
  const idx = last.index ?? 0;
  const summary = (text.slice(0, idx) + text.slice(idx + last[0].length)).trim();
  return { summary, votes };
}

// ---------------------------------------------------------------- votes + tally
export function loadVotes(): VoteRecord[] {
  if (!fs.existsSync(VOTES_CSV)) return [];
  const raw = fs.readFileSync(VOTES_CSV, "utf-8");
  if (!raw.trim()) return [];
  return parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
  }) as VoteRecord[];
}

export function appendVotes(votes: VoteRecord[]): number {
  const existingRows = loadVotes();
  const existingKeys = new Set(
    existingRows.map((r) => `${r.meeting_date}\0${r.body}\0${r.motion}`)
  );

  const additions: VoteRecord[] = [];
  for (const v of votes) {
    const key = `${v.meeting_date ?? ""}\0${v.body ?? ""}\0${v.motion ?? ""}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      additions.push({
        meeting_date: String(v.meeting_date ?? ""),
        body: String(v.body ?? ""),
        item: String(v.item ?? ""),
        motion: String(v.motion ?? ""),
        result: String(v.result ?? ""),
        yes: v.yes ?? "",
        no: v.no ?? "",
        abstain: v.abstain ?? "",
        source: String(v.source ?? ""),
      });
    }
  }

  if (additions.length > 0 || !fs.existsSync(VOTES_CSV)) {
    const all = [...existingRows, ...additions];
    const csv = stringifyCsv(all, {
      header: true,
      columns: VOTE_FIELDS,
    });
    fs.writeFileSync(VOTES_CSV, csv, "utf-8");
  }

  return additions.length;
}

export interface TallyRow {
  body: string;
  total: number;
  passed: number;
  failed: number;
  lastVote: string;
}

export function computeTally(rows = loadVotes()): TallyRow[] {
  const stats = new Map<string, TallyRow>();
  for (const row of rows) {
    const body = row.body || "Unknown";
    const s = stats.get(body) ?? {
      body,
      total: 0,
      passed: 0,
      failed: 0,
      lastVote: "",
    };
    s.total += 1;
    const res = (row.result || "").toLowerCase();
    if (/pass|approv|carri/.test(res)) {
      s.passed += 1;
    } else if (/fail|den|reject/.test(res)) {
      s.failed += 1;
    }
    if (row.meeting_date && row.meeting_date > s.lastVote) {
      s.lastVote = row.meeting_date;
    }
    stats.set(body, s);
  }
  return Array.from(stats.values()).sort((a, b) =>
    a.body.localeCompare(b.body)
  );
}

export function renderTallyMarkdown(rows = loadVotes()): string {
  const stats = computeTally(rows);
  if (!stats.length) return "_No votes recorded yet._";
  const lines = [
    "| Board / Committee | Votes | Passed | Failed | Last vote |",
    "|---|---|---|---|---|",
  ];
  for (const s of stats) {
    lines.push(
      `| ${s.body} | ${s.total} | ${s.passed} | ${s.failed} | ${s.lastVote} |`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- digests list
export function listDigests(): DigestItem[] {
  if (!fs.existsSync(DIGEST_DIR)) return [];
  const files = fs
    .readdirSync(DIGEST_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith("-prompt.txt"))
    .sort()
    .reverse();

  return files.map((filename) => {
    const full = path.join(DIGEST_DIR, filename);
    const stat = fs.statSync(full);
    const isPrompt = filename.endsWith("-prompt.txt");
    const date = filename
      .replace(/-prompt\.txt$/, "")
      .replace(/\.md$/, "");
    return {
      filename,
      date,
      isPrompt,
      content: fs.readFileSync(full, "utf-8"),
      updatedAt: stat.mtime.toISOString(),
    };
  });
}

// ---------------------------------------------------------------- live sources preview
export async function previewSources(dateOverride?: string): Promise<{
  today: string;
  weekStart: string;
  nextStart: string;
  nextEnd: string;
  agendasThisWeek: AgendaItem[];
  upcomingAgendas: AgendaItem[];
  recentMinutes: AgendaItem[];
  historicalDigests: HistoricalDigestMeta[];
  historicalLookbackDays: number;
  calendarText: string;
  logs: string[];
}> {
  const today = dateOverride || new Date().toISOString().slice(0, 10);
  const weekStart = isoDateDaysAgo(today, 7);
  const nextStart = isoDateDaysAhead(today, 1);
  const nextEnd = isoDateDaysAhead(today, 8);
  const minCutoff = isoDateDaysAgo(today, 60);
  const logs: string[] = [];

  let items = new Map<string, AgendaItem>();
  try {
    items = await scrapeAgendaCenter(logs);
  } catch (err) {
    logs.push(
      `Agenda Center fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const agendasThisWeek: AgendaItem[] = [];
  const upcomingAgendas: AgendaItem[] = [];
  const recentMinutes: AgendaItem[] = [];

  for (const it of items.values()) {
    if (it.kind === "Agenda" && it.date >= weekStart && it.date <= today) {
      agendasThisWeek.push(it);
    } else if (
      it.kind === "Agenda" &&
      it.date >= nextStart &&
      it.date <= nextEnd
    ) {
      upcomingAgendas.push(it);
    } else if (it.kind === "Minutes" && it.date >= minCutoff) {
      recentMinutes.push(it);
    }
  }

  const calendarText = await upcomingCalendar(logs);
  const historicalDigests = listHistoricalDigests(today);

  return {
    today,
    weekStart,
    nextStart,
    nextEnd,
    agendasThisWeek,
    upcomingAgendas,
    recentMinutes,
    historicalDigests,
    historicalLookbackDays: HISTORY_LOOKBACK_DAYS,
    calendarText,
    logs,
  };
}

// ---------------------------------------------------------------- main digest runner
export async function runDigest(
  options: DigestRunOptions = {},
  logs: string[] = []
): Promise<{
  today: string;
  weekStart: string;
  promptOnly: boolean;
  dryRun: boolean;
  outFile: string;
  digest: string;
  summary: string;
  prompt: string;
  votes: VoteRecord[];
  addedVotes: number;
  sources: {
    transcriptsCount: number;
    agendasCount: number;
    minutesCount: number;
    upcomingCount: number;
    historyTier1Count: number;
    historyTier2Count: number;
    historyVotesCount: number;
  };
  logs: string[];
}> {
  const today = options.date || new Date().toISOString().slice(0, 10);
  const weekStart = isoDateDaysAgo(today, 7);
  const nextStart = isoDateDaysAhead(today, 1);
  const nextEnd = isoDateDaysAhead(today, 8);
  const minCutoff = isoDateDaysAgo(today, 60);

  const state = options.ignoreState ? { seen: [] } : loadState();
  const seen = new Set(state.seen);
  fs.mkdirSync(DIGEST_DIR, { recursive: true });

  logs.push(`Running digest for week ending ${today} (${weekStart} to ${today})`);

  // 1. Transcripts (saved first, then optional live fetch)
  const transcripts: string[] = [];
  const newKeys: string[] = [];
  const stored = loadSavedTranscriptsMap(today);
  const savedVideoIds = new Set(listSavedTranscripts().map((t) => t.videoId));
  for (const [key, block] of stored.entries()) {
    if (!seen.has(key)) {
      transcripts.push(block);
      newKeys.push(key);
    }
  }
  logs.push(`${transcripts.length} new saved transcript(s) found in transcripts/`);

  const skipYt = options.skipYtFetch || process.env.SKIP_YT_FETCH === "1";
  if (!skipYt) {
    try {
      const videos = await recentVideos(today, logs);
      for (const v of videos) {
        const key = `yt-${v.id}`;
        if (
          seen.has(key) ||
          stored.has(key) ||
          savedVideoIds.has(v.id) ||
          SKIP_TITLES.test(v.title)
        ) {
          continue;
        }
        logs.push(`transcript: ${v.title}`);
        // Use Gemini video fallback only for meetings within this digest's week
        const allowFallback = !options.promptOnly && v.published >= weekStart;
        const t = await resolveVideoTranscript(v, logs, allowFallback);
        if (t) {
          if (!options.dryRun) {
            fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
            const cachePath = path.join(TRANSCRIPT_DIR, `${v.published}_${v.id}.txt`);
            if (!fs.existsSync(cachePath)) {
              fs.writeFileSync(
                cachePath,
                `TITLE: ${v.title}\nURL: ${v.url}\nPUBLISHED: ${v.published}\n\n${t}`,
                "utf-8"
              );
            }
          }
          transcripts.push(
            `=== VIDEO: ${v.title} (posted ${v.published}) ${v.url} ===\n${t.slice(
              0,
              TRANSCRIPT_CHAR_CAP
            )}`
          );
          newKeys.push(key);
        }
      }
    } catch (err) {
      logs.push(
        `YouTube step failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    logs.push("Skipped live YouTube fetch (SKIP_YT_FETCH enabled)");
  }

  // 2. Agenda Center
  const agendas: string[] = [];
  const minutes: string[] = [];
  const upcoming: string[] = [];

  try {
    const items = await scrapeAgendaCenter(logs);
    const allowOcr = !options.promptOnly;
    for (const [key, it] of items.entries()) {
      const head = `=== ${it.kind.toUpperCase()}: ${it.body} | meeting date ${it.date} | ${it.url} ===`;
      if (it.kind === "Agenda" && it.date >= weekStart && it.date <= today) {
        const txt = await fetchDoc(it.url, logs, DOC_CHAR_CAP, allowOcr);
        if (txt) agendas.push(`${head}\n${txt}`);
      } else if (
        it.kind === "Agenda" &&
        it.date >= nextStart &&
        it.date <= nextEnd
      ) {
        const txt = await fetchDoc(it.url, logs, 15_000, allowOcr);
        if (txt) upcoming.push(`${head}\n${txt}`);
      } else if (
        it.kind === "Minutes" &&
        !seen.has(key) &&
        it.date >= minCutoff
      ) {
        const txt = await fetchDoc(it.url, logs, DOC_CHAR_CAP, allowOcr);
        if (txt) {
          minutes.push(`${head}\n${txt}`);
          newKeys.push(key);
        }
      }
    }
  } catch (err) {
    logs.push(
      `Agenda Center step failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 3. Roster & Planning docs & Historical context & Calendar
  const rosterText = promptContext();
  if (!rosterText) {
    logs.push("warning: roster.csv is empty or missing; refresh the roster first");
  }
  const plan = await loadPlanningDocs(logs);
  const history = loadHistoricalContext(today, weekStart, logs);
  const calendar = await upcomingCalendar(logs);

  const prompt = buildPrompt({
    plan,
    historyTier1: history.tier1Blocks,
    historyTier2: history.tier2Blocks,
    historyVotes: history.votesText,
    transcripts,
    agendas,
    minutes,
    upcoming,
    calendar,
    weekStart,
    today,
    rosterText,
  });

  if (options.promptOnly) {
    const promptPath = path.join(DIGEST_DIR, `${today}-prompt.txt`);
    fs.writeFileSync(promptPath, prompt, "utf-8");
    logs.push(
      `Wrote digests/${today}-prompt.txt (${prompt.length.toLocaleString()} chars).`
    );
    return {
      today,
      weekStart,
      promptOnly: true,
      dryRun: Boolean(options.dryRun),
      outFile: `digests/${today}-prompt.txt`,
      digest: "",
      summary: "",
      prompt,
      votes: [],
      addedVotes: 0,
      sources: {
        transcriptsCount: transcripts.length,
        agendasCount: agendas.length,
        minutesCount: minutes.length,
        upcomingCount: upcoming.length,
        historyTier1Count: history.tier1Count,
        historyTier2Count: history.tier2Count,
        historyVotesCount: history.votesCount,
      },
      logs,
    };
  }

  let summary = "_No meeting material found for this week._";
  let votes: VoteRecord[] = [];
  if (
    transcripts.length ||
    agendas.length ||
    minutes.length ||
    upcoming.length
  ) {
    const raw = await callGemini(prompt, logs);
    const parsed = splitVotes(raw);
    summary = parsed.summary;
    votes = parsed.votes;
  } else {
    logs.push("No meeting material found for this week.");
  }

  const addedVotes = options.dryRun ? 0 : appendVotes(votes);
  const changes = recentChanges(today);
  const rosterMd = changes.length
    ? `## Board & committee membership changes\n\n${changes
        .map((c) => `- ${c}`)
        .join("\n")}\n\n_Full table: roster.md_\n\n`
    : "";

  const tallyMd = renderTallyMarkdown();
  const digest = `# Swampscott Civic Digest — week ending ${today}\n\n${summary}\n\n${rosterMd}## Running vote tally by board/committee\n\n${tallyMd}\n\n_Auto-generated by an LLM from public sources; check the linked agendas, minutes and videos before relying on any detail._\n`;

  const outPath = path.join(DIGEST_DIR, `${today}.md`);
  fs.writeFileSync(outPath, digest, "utf-8");
  logs.push(`Wrote digests/${today}.md; ${addedVotes} new vote(s) recorded`);

  if (!options.dryRun) {
    saveState({ seen: [...seen, ...newKeys] });
    logs.push("Updated state.json");
  } else {
    logs.push("Dry run: state.json and votes.csv were not modified");
  }

  return {
    today,
    weekStart,
    promptOnly: false,
    dryRun: Boolean(options.dryRun),
    outFile: `digests/${today}.md`,
    digest,
    summary,
    prompt,
    votes,
    addedVotes,
    sources: {
      transcriptsCount: transcripts.length,
      agendasCount: agendas.length,
      minutesCount: minutes.length,
      upcomingCount: upcoming.length,
      historyTier1Count: history.tier1Count,
      historyTier2Count: history.tier2Count,
      historyVotesCount: history.votesCount,
    },
    logs,
  };
}

// ---------------------------------------------------------------- hybrid historical backfill (Option 2)
export interface BackfillOptions {
  endDate?: string;
  lookbackDays?: number;
  recentWeeks?: number;
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface BackfillSlice {
  kind: "monthly" | "weekly";
  label: string;
  start: string;
  end: string;
}

export interface BackfillSliceResult {
  kind: "monthly" | "weekly";
  label: string;
  start: string;
  end: string;
  outFile: string;
  status: "generated" | "skipped_existing" | "skipped_empty" | "dry_run";
  agendasUsed: number;
  minutesUsed: number;
  transcriptsUsed: number;
  addedVotes: number;
}

const MONTHLY_ARCHIVE_INSTRUCTIONS = `You are producing a concise monthly historical civic archive digest for Swampscott, Massachusetts.
Use ONLY the material below. Never invent votes, names, numbers or decisions. If a vote count or
outcome is unclear from the sources, say so and leave fields null.
Use the BOARD/COMMITTEE ROSTER section to normalize member spellings and roles where supported.
Use HISTORICAL CONTEXT sections ONLY to recognize continuity across months (continued hearings,
tabled articles, ongoing projects). NEVER re-report prior months' meetings as occurring in this
month, and NEVER include prior votes from HISTORICAL CONTEXT in this month's final \`\`\`json votes array.

Write Markdown with these sections:

## Meetings this month
Group concisely by board/committee and date (include source links). Summarize key topics,
continuances, approvals/denials, and decisions in 2-5 crisp bullets per meeting; note when only
an agenda (no minutes/transcript) was available.

## Connections to town planning documents
Briefly note genuine connections to the planning documents provided (skip if none).

Then output a final fenced \`\`\`json block containing an array of every formal vote taken in this
month's meetings, with objects of the form:
{"meeting_date":"YYYY-MM-DD","body":"","item":"","motion":"","result":"passed|failed|tabled|continued|other",
 "yes":null,"no":null,"abstain":null,"source":"URL"}
Use [] if no formal votes are documented. Voice votes: leave counts null.`;

const WEEKLY_BACKFILL_INSTRUCTIONS = `You are producing a historical weekly civic digest for Swampscott, Massachusetts.
Use ONLY the material below. Never invent votes, names, numbers or decisions. If a vote count or
outcome is unclear from the sources, say so and leave fields null.
Use the BOARD/COMMITTEE ROSTER section to normalize member spellings and roles where supported.
Use HISTORICAL CONTEXT sections ONLY as background continuity (continued hearings, prior votes,
ongoing projects). NEVER re-report prior weeks' meetings as occurring this week, and NEVER include
historical votes from HISTORICAL CONTEXT in this week's final \`\`\`json votes array.

Write Markdown with these sections (omit "## Coming up next week" since this is a historical edition):

## Meetings this week
For each meeting: board/committee, date, source(s), then 3-8 bullets on what was discussed and any
decisions. Prefer minutes/agenda facts; use transcripts for discussion color; note brief continuity
from prior digests when relevant. Note when only an agenda (no minutes/transcript) was available.

## Connections to town planning documents
Only where genuinely relevant, note how an item relates to the planning documents provided
(name the document and section/goal if identifiable). Skip if nothing connects.

Then output a final fenced \`\`\`json block containing an array of every formal vote taken in this
week's meetings, with objects of the form:
{"meeting_date":"YYYY-MM-DD","body":"","item":"","motion":"","result":"passed|failed|tabled|continued|other",
 "yes":null,"no":null,"abstain":null,"source":"URL"}
Use [] if no formal votes are documented. Voice votes: leave counts null.`;

function lastDayOfMonthIso(ym: string): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function nextMonthYm(ym: string): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  if (m === 12) return `${y + 1}-01`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function planHybridBackfillSlices(
  endDate: string,
  lookbackDays = HISTORY_LOOKBACK_DAYS,
  recentWeeks = 8
): BackfillSlice[] {
  const cutoff = isoDateDaysAgo(endDate, lookbackDays);
  const weeklySlices: BackfillSlice[] = [];

  for (let w = 0; w < recentWeeks; w++) {
    const sliceEnd = isoDateDaysAgo(endDate, w * 7);
    if (sliceEnd < cutoff) break;
    let sliceStart = isoDateDaysAgo(sliceEnd, 6);
    if (sliceStart < cutoff) sliceStart = cutoff;
    weeklySlices.push({
      kind: "weekly",
      label: `week ${sliceStart}..${sliceEnd}`,
      start: sliceStart,
      end: sliceEnd,
    });
    if (sliceStart <= cutoff) break;
  }

  const oldestWeeklyStart = weeklySlices.length
    ? weeklySlices[weeklySlices.length - 1].start
    : isoDateDaysAhead(endDate, 1);
  const monthlyUpper = isoDateDaysAgo(oldestWeeklyStart, 1);

  const monthlySlices: BackfillSlice[] = [];
  if (cutoff <= monthlyUpper) {
    let ym = cutoff.slice(0, 7);
    const endYm = monthlyUpper.slice(0, 7);
    while (ym <= endYm) {
      const mStart = ym === cutoff.slice(0, 7) ? cutoff : `${ym}-01`;
      const mLast = lastDayOfMonthIso(ym);
      const mEnd = mLast < monthlyUpper ? mLast : monthlyUpper;
      if (mStart <= mEnd) {
        monthlySlices.push({
          kind: "monthly",
          label: ym,
          start: mStart,
          end: mEnd,
        });
      }
      ym = nextMonthYm(ym);
    }
  }

  return [...monthlySlices, ...weeklySlices.reverse()];
}

export async function backfillHistory(
  options: BackfillOptions = {},
  logs: string[] = []
): Promise<{
  endDate: string;
  lookbackDays: number;
  recentWeeks: number;
  dryRun: boolean;
  totalSlices: number;
  generatedCount: number;
  skippedCount: number;
  totalAddedVotes: number;
  slices: BackfillSliceResult[];
  logs: string[];
}> {
  const endDate =
    options.endDate && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate)
      ? options.endDate
      : isoDateDaysAgo(new Date().toISOString().slice(0, 10), 7);
  const lookbackDays = Math.max(
    14,
    Math.min(730, Number(options.lookbackDays || HISTORY_LOOKBACK_DAYS))
  );
  const recentWeeks = Math.max(
    0,
    Math.min(26, Number(options.recentWeeks ?? 8))
  );
  const overwrite = Boolean(options.overwrite);
  const dryRun = Boolean(options.dryRun);

  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  const slices = planHybridBackfillSlices(endDate, lookbackDays, recentWeeks);
  const monthlyCount = slices.filter((s) => s.kind === "monthly").length;
  const weeklyCount = slices.filter((s) => s.kind === "weekly").length;
  logs.push(
    `Hybrid backfill plan (${lookbackDays}d up to ${endDate}): ${monthlyCount} monthly archive(s) + ${weeklyCount} recent weekly digest(s) (${slices.length} total)`
  );

  // 1. Scrape Agenda Center once & load transcripts/planning/roster once
  const allItems = await scrapeAgendaCenter(logs);
  const savedTranscripts = listSavedTranscripts();
  const rosterText = promptContext();
  const plan = await loadPlanningDocs(logs);

  const itemsBySlice = new Map<
    string,
    { agendas: AgendaItem[]; minutes: AgendaItem[]; transcripts: TranscriptItem[] }
  >();
  const neededDocs = new Map<string, AgendaItem>();
  const seenKeysToSeed = new Set<string>(loadState().seen);

  for (const slice of slices) {
    const outPath = path.join(DIGEST_DIR, `${slice.end}.md`);
    const exists = fs.existsSync(outPath);

    const sliceMinutes: AgendaItem[] = [];
    const sliceAgendasAll: AgendaItem[] = [];
    for (const it of allItems.values()) {
      if (it.date < slice.start || it.date > slice.end) continue;
      if (it.kind === "Minutes") {
        sliceMinutes.push(it);
        seenKeysToSeed.add(it.key);
      } else {
        sliceAgendasAll.push(it);
      }
    }

    // For monthly archives, avoid redundant agenda PDFs when Minutes exist for same (date, body)
    const minuteSignatures = new Set(
      sliceMinutes.map((m) => `${m.date}\0${m.body.toLowerCase()}`)
    );
    const sliceAgendas =
      slice.kind === "monthly"
        ? sliceAgendasAll.filter(
            (a) => !minuteSignatures.has(`${a.date}\0${a.body.toLowerCase()}`)
          )
        : sliceAgendasAll;

    const sliceTranscripts = savedTranscripts.filter(
      (t) => t.published >= slice.start && t.published <= slice.end
    );
    for (const t of sliceTranscripts) {
      seenKeysToSeed.add(`yt-${t.videoId}`);
    }

    itemsBySlice.set(slice.end, {
      agendas: sliceAgendas,
      minutes: sliceMinutes,
      transcripts: sliceTranscripts,
    });

    if (!exists || overwrite) {
      for (const it of [...sliceMinutes, ...sliceAgendas]) {
        neededDocs.set(it.key, it);
      }
    }
  }

  // 2. Fetch and extract each unique needed PDF once (concurrency 4)
  const docCache = new Map<string, string>();
  const docList = Array.from(neededDocs.values());
  logs.push(
    `Fetching ${docList.length} unique agenda/minutes document(s) for pending slices (skipping already-generated digests)...`
  );

  let cursor = 0;
  let fetchedCount = 0;
  const concurrency = 4;
  async function worker() {
    while (cursor < docList.length) {
      const idx = cursor++;
      const it = docList[idx];
      const cap = it.kind === "Minutes" ? DOC_CHAR_CAP : 15_000;
      const txt = await fetchDoc(it.url, logs, cap, !dryRun);
      if (txt) {
        docCache.set(it.key, txt);
      }
      fetchedCount++;
      if (fetchedCount % 25 === 0 || fetchedCount === docList.length) {
        logs.push(`  extracted ${fetchedCount}/${docList.length} document(s)`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, docList.length) }, () => worker())
  );

  // 3. Generate chronologically (oldest -> newest) so each slice informs subsequent ones
  const results: BackfillSliceResult[] = [];
  let generatedCount = 0;
  let skippedCount = 0;
  let totalAddedVotes = 0;
  const recentThresholdStart =
    slices.length > 4 ? slices[slices.length - 4].end : "0000-00-00";

  for (const slice of slices) {
    const outFile = `digests/${slice.end}.md`;
    const outPath = path.join(DIGEST_DIR, `${slice.end}.md`);
    const bundle = itemsBySlice.get(slice.end)!;

    if (fs.existsSync(outPath) && !overwrite) {
      logs.push(`Skip existing ${outFile} (${slice.kind} ${slice.label})`);
      skippedCount++;
      results.push({
        kind: slice.kind,
        label: slice.label,
        start: slice.start,
        end: slice.end,
        outFile,
        status: "skipped_existing",
        agendasUsed: bundle.agendas.length,
        minutesUsed: bundle.minutes.length,
        transcriptsUsed: bundle.transcripts.length,
        addedVotes: 0,
      });
      continue;
    }

    const transcriptBlocks = bundle.transcripts.map(
      (t) =>
        `=== VIDEO: ${t.title} (posted ${t.published}) ${t.url} ===\n${t.content.slice(
          0,
          TRANSCRIPT_CHAR_CAP
        )}`
    );
    const agendaBlocks: string[] = [];
    for (const it of bundle.agendas) {
      const txt = docCache.get(it.key);
      if (txt) {
        agendaBlocks.push(
          `=== AGENDA: ${it.body} | meeting date ${it.date} | ${it.url} ===\n${txt}`
        );
      }
    }
    const minuteBlocks: string[] = [];
    for (const it of bundle.minutes) {
      const txt = docCache.get(it.key);
      if (txt) {
        minuteBlocks.push(
          `=== MINUTES: ${it.body} | meeting date ${it.date} | ${it.url} ===\n${txt}`
        );
      }
    }

    if (!transcriptBlocks.length && !agendaBlocks.length && !minuteBlocks.length) {
      logs.push(`Skip empty ${slice.kind} ${slice.label} (no source documents)`);
      skippedCount++;
      results.push({
        kind: slice.kind,
        label: slice.label,
        start: slice.start,
        end: slice.end,
        outFile,
        status: "skipped_empty",
        agendasUsed: 0,
        minutesUsed: 0,
        transcriptsUsed: 0,
        addedVotes: 0,
      });
      continue;
    }

    if (dryRun) {
      logs.push(
        `[Dry run] Would generate ${outFile} (${slice.kind} ${slice.label}: ${minuteBlocks.length} minutes, ${agendaBlocks.length} agendas, ${transcriptBlocks.length} transcripts)`
      );
      results.push({
        kind: slice.kind,
        label: slice.label,
        start: slice.start,
        end: slice.end,
        outFile,
        status: "dry_run",
        agendasUsed: agendaBlocks.length,
        minutesUsed: minuteBlocks.length,
        transcriptsUsed: transcriptBlocks.length,
        addedVotes: 0,
      });
      continue;
    }

    const sliceLogs: string[] = [];
    const history = loadHistoricalContext(slice.end, slice.start, sliceLogs);
    const instr =
      slice.kind === "monthly"
        ? MONTHLY_ARCHIVE_INSTRUCTIONS
        : WEEKLY_BACKFILL_INSTRUCTIONS;
    const periodLabel =
      slice.kind === "monthly"
        ? `Month covered: ${slice.label} (${slice.start} to ${slice.end}).`
        : `Week covered: ${slice.start} to ${slice.end}.`;

    const prompt =
      instr +
      `\n\n${periodLabel}` +
      section(
        "BOARD/COMMITTEE ROSTER (current members and roles)",
        rosterText ? [rosterText] : []
      ) +
      section("PLANNING DOCUMENTS (context only)", plan ? [plan] : []) +
      section(
        `HISTORICAL CONTEXT — TIER 1 (last ${HISTORY_RECENT_WEEKS} digests, full)`,
        history.tier1Blocks
      ) +
      section(
        `HISTORICAL CONTEXT — TIER 2 (older digests up to ${HISTORY_LOOKBACK_DAYS} days, condensed)`,
        history.tier2Blocks
      ) +
      section(
        "HISTORICAL CONTEXT — PRIOR FORMAL VOTES LOG (background only; do not re-emit)",
        history.votesText ? [history.votesText] : []
      ) +
      section("THIS PERIOD: VIDEO TRANSCRIPTS", transcriptBlocks) +
      section("THIS PERIOD: MINUTES", minuteBlocks) +
      section("THIS PERIOD: AGENDAS", agendaBlocks);

    // Use fast lite model for monthly archives & older Tier 2 weeks; hydrogen for latest 4 weeks
    const preferredModels =
      slice.kind === "weekly" && slice.end >= recentThresholdStart
        ? ["gemini-4-hydrogen", "gemini-3.1-flash-lite"]
        : ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];

    logs.push(
      `Generating ${outFile} (${slice.kind} ${slice.label}: ${minuteBlocks.length} min, ${agendaBlocks.length} ag, ${transcriptBlocks.length} tr)...`
    );
    const raw = await callGemini(prompt, logs, preferredModels);
    const parsed = splitVotes(raw);
    const addedVotes = appendVotes(parsed.votes);
    totalAddedVotes += addedVotes;

    const tallyMd = renderTallyMarkdown();
    const header =
      slice.kind === "monthly"
        ? `# Swampscott Civic Digest — monthly archive ${slice.label} (${slice.start} to ${slice.end})`
        : `# Swampscott Civic Digest — week ending ${slice.end}`;
    const digest = `${header}\n\n${parsed.summary}\n\n## Running vote tally by board/committee\n\n${tallyMd}\n\n_Auto-generated by an LLM from public sources; check the linked agendas, minutes and videos before relying on any detail._\n`;

    fs.writeFileSync(outPath, digest, "utf-8");
    generatedCount++;
    logs.push(`  wrote ${outFile}; +${addedVotes} vote(s)`);

    results.push({
      kind: slice.kind,
      label: slice.label,
      start: slice.start,
      end: slice.end,
      outFile,
      status: "generated",
      agendasUsed: agendaBlocks.length,
      minutesUsed: minuteBlocks.length,
      transcriptsUsed: transcriptBlocks.length,
      addedVotes,
    });
  }

  if (!dryRun) {
    saveState({ seen: Array.from(seenKeysToSeed) });
    logs.push(
      `Backfill complete: generated ${generatedCount}, skipped ${skippedCount}, +${totalAddedVotes} new vote(s); state.json seeded (${seenKeysToSeed.size} seen keys).`
    );
  } else {
    logs.push(
      `Dry run complete: ${results.filter((r) => r.status === "dry_run").length} slice(s) planned, ${skippedCount} skipped.`
    );
  }

  return {
    endDate,
    lookbackDays,
    recentWeeks,
    dryRun,
    totalSlices: slices.length,
    generatedCount,
    skippedCount,
    totalAddedVotes,
    slices: results,
    logs,
  };
}
