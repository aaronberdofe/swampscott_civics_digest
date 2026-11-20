import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";

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

export interface ParsedMember {
  name: string;
  role: string;
  seat: string;
  term_expires: string;
}

const ROOT = process.cwd();
const SITE = "https://www.swampscottma.gov";
const SITEMAP = `${SITE}/sitemap`;
const BOARDS_SECTION_ID = "/1196/";
const SKIP_TITLES = /agendas?\s*&\s*minutes/i;

export const ROSTER_CSV = path.join(ROOT, "roster.csv");
export const ROSTER_MD = path.join(ROOT, "roster.md");
export const CHANGES_JSON = path.join(ROOT, "roster_changes.json");

const FIELDS: (keyof RosterRow)[] = [
  "body",
  "name",
  "role",
  "seat",
  "term_expires",
  "status",
  "first_seen",
  "last_seen",
  "source",
];

const UA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; swampscott-civic-digest/1.0)",
};

function normSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function fetchHtml(url: string, timeoutMs = 45000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: UA_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function discoverBoards(html: string): Array<[string, string]> {
  const $ = cheerio.load(html);
  const candidates = $("h1, h2, h3, h4, h5, h6, ol, ul").toArray();
  let sectionIdx = -1;

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!/^h[1-6]$/i.test(el.tagName)) continue;
    const link = $(el)
      .find("a[href]")
      .toArray()
      .find((a) => ($(a).attr("href") || "").includes(BOARDS_SECTION_ID));
    if (link) {
      sectionIdx = i;
      break;
    }
  }

  if (sectionIdx === -1) return [];

  let listEl: (typeof candidates)[number] | null = null;
  for (let i = sectionIdx + 1; i < candidates.length; i++) {
    const tag = candidates[i].tagName.toLowerCase();
    if (tag === "ol" || tag === "ul") {
      listEl = candidates[i];
      break;
    }
  }

  if (!listEl) return [];

  const boards: Array<[string, string]> = [];
  $(listEl)
    .children("li")
    .each((_, li) => {
      const a = $(li).find("a[href]").first();
      if (!a.length) return;
      const title = normSpace(a.text());
      const href = a.attr("href");
      if (title && href && !SKIP_TITLES.test(title)) {
        const resolved = new URL(href, SITE).toString();
        boards.push([title, resolved]);
      }
    });

  return boards;
}

export function splitNameRole(text: string): [string, string] | null {
  const clean = normSpace(text);
  let name = clean;
  let role = "Member";

  const commaOrDash = clean.match(/^(.*?)(?:,|\s[–—-]\s)\s*(.+)$/);
  if (commaOrDash) {
    name = commaOrDash[1];
    role = commaOrDash[2];
  } else {
    const paren = clean.match(/^(.*?)\s*\((.+)\)$/);
    if (paren) {
      name = paren[1];
      role = paren[2];
    }
  }

  name = name.replace(/^[\s,.;]+|[\s,.;]+$/g, "");
  if (!name || name.length > 60 || /\d|vacan/i.test(name)) {
    return null;
  }
  return [name, role.trim() || "Member"];
}

export function parseMembers(html: string): ParsedMember[] | null {
  const $ = cheerio.load(html);
  const allEls = $("h1, h2, h3, h4, h5, h6, table, ul, ol").toArray();

  let headIdx = -1;
  let headLevel = 6;
  for (let i = 0; i < allEls.length; i++) {
    const el = allEls[i];
    if (!/^h[1-6]$/i.test(el.tagName)) continue;
    const text = normSpace($(el).text());
    if (/^\s*(current\s+)?(board\s+)?member(s|ship)?\b/i.test(text)) {
      headIdx = i;
      headLevel = parseInt(el.tagName.slice(1), 10);
      break;
    }
  }

  if (headIdx === -1) return null;

  let tableEl: (typeof allEls)[number] | null = null;
  let itemsEl: (typeof allEls)[number] | null = null;

  for (let i = headIdx + 1; i < allEls.length; i++) {
    const el = allEls[i];
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag) && parseInt(tag.slice(1), 10) <= headLevel) {
      break;
    }
    if (tag === "table") {
      tableEl = el;
      break;
    }
    if ((tag === "ul" || tag === "ol") && itemsEl === null) {
      itemsEl = el;
    }
  }

  const members: ParsedMember[] = [];

  if (tableEl) {
    const rows = $(tableEl).find("tr").toArray();
    if (!rows.length) return [];

    const firstCells = $(rows[0])
      .find("th, td")
      .toArray()
      .map((c) => normSpace($(c).text()));

    const hasHeader =
      $(rows[0]).find("th").length > 0 ||
      firstCells.some((c) => /member|name|expir|term/i.test(c));

    const idxExp = firstCells.findIndex((c) =>
      /ex\w{0,2}ir|expir|term end/i.test(c)
    );
    const idxSeat = firstCells.findIndex((c) =>
      /seat|term label|position/i.test(c)
    );

    const dataRows = hasHeader ? rows.slice(1) : rows;
    for (const tr of dataRows) {
      const cells = $(tr)
        .find("td, th")
        .toArray()
        .map((c) => normSpace($(c).text()));
      if (!cells.length) continue;
      const nr = splitNameRole(cells[0]);
      if (!nr) continue;
      members.push({
        name: nr[0],
        role: nr[1],
        seat: idxSeat !== -1 && idxSeat < cells.length ? cells[idxSeat] : "",
        term_expires:
          idxExp !== -1 && idxExp < cells.length ? cells[idxExp] : "",
      });
    }
  } else if (itemsEl) {
    $(itemsEl)
      .find("li")
      .each((_, li) => {
        const nr = splitNameRole(normSpace($(li).text()));
        if (nr) {
          members.push({
            name: nr[0],
            role: nr[1],
            seat: "",
            term_expires: "",
          });
        }
      });
  }

  return members;
}

export function loadRoster(): RosterRow[] {
  if (!fs.existsSync(ROSTER_CSV)) return [];
  const raw = fs.readFileSync(ROSTER_CSV, "utf-8");
  if (!raw.trim()) return [];
  const records = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
  }) as RosterRow[];
  return records.map((r) => ({
    body: r.body ?? "",
    name: r.name ?? "",
    role: r.role ?? "",
    seat: r.seat ?? "",
    term_expires: r.term_expires ?? "",
    status: r.status ?? "active",
    first_seen: r.first_seen ?? "",
    last_seen: r.last_seen ?? "",
    source: r.source ?? "",
  }));
}

export function saveRoster(rows: RosterRow[]): void {
  const sorted = [...rows].sort((a, b) => {
    const bodyCmp = a.body.toLowerCase().localeCompare(b.body.toLowerCase());
    if (bodyCmp !== 0) return bodyCmp;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  const csv = stringifyCsv(sorted, {
    header: true,
    columns: FIELDS,
  });
  fs.writeFileSync(ROSTER_CSV, csv, "utf-8");
}

export function renderMarkdown(rows: RosterRow[], today: string): string {
  const out: string[] = [
    "# Swampscott Boards & Committees — Current Members\n",
    `_Scraped from swampscottma.gov, last updated ${today}. Check the board's page for the official roster._\n`,
  ];
  const bodies = new Map<string, RosterRow[]>();
  for (const r of rows) {
    if (r.status === "active") {
      const arr = bodies.get(r.body) ?? [];
      arr.push(r);
      bodies.set(r.body, arr);
    }
  }
  const sortedBodies = Array.from(bodies.keys()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  for (const body of sortedBodies) {
    out.push(`\n## ${body}\n`);
    out.push("| Name | Role | Seat | Term expires | First seen |");
    out.push("|---|---|---|---|---|");
    const members = (bodies.get(body) ?? []).sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    for (const r of members) {
      out.push(
        `| ${r.name} | ${r.role} | ${r.seat} | ${r.term_expires} | ${r.first_seen} |`
      );
    }
  }
  const md = out.join("\n") + "\n";
  fs.writeFileSync(ROSTER_MD, md, "utf-8");
  return md;
}

export function mergeRoster(
  oldRows: RosterRow[],
  scraped: Map<string, { url: string; members: ParsedMember[] }>,
  today: string
): { rows: RosterRow[]; changes: string[] } {
  const byKey = new Map<string, RosterRow>();
  for (const r of oldRows) {
    byKey.set(`${r.body}\0${r.name.toLowerCase()}`, { ...r });
  }
  const changes: string[] = [];

  for (const [body, { url, members }] of scraped.entries()) {
    const present = new Set<string>();
    for (const m of members) {
      const key = `${body}\0${m.name.toLowerCase()}`;
      present.add(key);
      const row = byKey.get(key);
      if (!row) {
        byKey.set(key, {
          body,
          name: m.name,
          role: m.role,
          seat: m.seat,
          term_expires: m.term_expires,
          status: "active",
          first_seen: today,
          last_seen: today,
          source: url,
        });
        changes.push(`${m.name} added to ${body} (${m.role})`);
        continue;
      }
      if (row.status === "departed") {
        row.status = "active";
        changes.push(`${m.name} is listed again on ${body} (${m.role})`);
      }
      if (m.role !== row.role) {
        changes.push(
          `${m.name} on ${body}: role changed from ${row.role} to ${m.role}`
        );
        row.role = m.role;
      }
      for (const [fld, label] of [
        ["seat", "seat"],
        ["term_expires", "term expiration"],
      ] as const) {
        if (m[fld] && m[fld] !== row[fld]) {
          if (row[fld]) {
            changes.push(
              `${m.name} on ${body}: ${label} changed from ${row[fld]} to ${m[fld]}`
            );
          }
          row[fld] = m[fld];
        }
      }
      row.last_seen = today;
      row.source = url;
    }

    if (members.length > 0) {
      for (const [key, row] of byKey.entries()) {
        if (
          row.body === body &&
          row.status === "active" &&
          !present.has(key)
        ) {
          row.status = "departed";
          changes.push(`${row.name} no longer listed on ${body}`);
        }
      }
    }
  }

  return { rows: Array.from(byKey.values()), changes };
}

export function promptContext(): string {
  const rows = loadRoster().filter((r) => r.status === "active");
  const byBody = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byBody.get(r.body) ?? [];
    arr.push(`${r.name} (${r.role})`);
    byBody.set(r.body, arr);
  }
  return Array.from(byBody.keys())
    .sort()
    .map((b) => `${b}: ${(byBody.get(b) ?? []).join("; ")}`)
    .join("\n");
}

export function loadChangesJson(): RosterChanges | null {
  if (!fs.existsSync(CHANGES_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHANGES_JSON, "utf-8")) as RosterChanges;
  } catch {
    return null;
  }
}

export function recentChanges(todayIso: string): string[] {
  const d = loadChangesJson();
  if (d && d.date === todayIso && !d.initial) {
    return d.changes ?? [];
  }
  return [];
}

export function readRosterMarkdown(): string {
  if (!fs.existsSync(ROSTER_MD)) return "";
  return fs.readFileSync(ROSTER_MD, "utf-8");
}

export async function refreshRoster(
  dateOverride?: string,
  logs: string[] = []
): Promise<{
  rows: RosterRow[];
  changes: RosterChanges;
  boardsScanned: number;
  logs: string[];
}> {
  const today = dateOverride || new Date().toISOString().slice(0, 10);

  logs.push(`Fetching sitemap: ${SITEMAP}`);
  const sitemapHtml = await fetchHtml(SITEMAP);
  const boards = discoverBoards(sitemapHtml);
  logs.push(`Found ${boards.length} boards/committees in the sitemap`);

  if (!boards.length) {
    throw new Error(
      "Could not read the Boards & Committees section of the sitemap; roster unchanged."
    );
  }

  const scraped = new Map<string, { url: string; members: ParsedMember[] }>();
  const noRoster: string[] = [];

  for (const [title, url] of boards) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const html = await fetchHtml(url, 30000);
      const members = parseMembers(html);
      if (members === null) {
        logs.push(`  ${title}: no Members section`);
        noRoster.push(title);
      } else if (!members.length) {
        logs.push(`  ${title}: Members section empty/unparsed`);
        noRoster.push(title);
      } else {
        logs.push(`  ${title}: ${members.length} members`);
        scraped.set(title, { url, members });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`  ${title}: fetch failed (${msg})`);
      noRoster.push(title);
    }
  }

  if (!scraped.size) {
    throw new Error("No members parsed from any page; roster unchanged.");
  }

  const oldRows = loadRoster();
  const initial = oldRows.length === 0;
  const { rows, changes } = mergeRoster(oldRows, scraped, today);
  saveRoster(rows);
  renderMarkdown(rows, today);

  const changesObj: RosterChanges = {
    date: today,
    initial,
    changes,
    no_roster_found: noRoster,
  };
  fs.writeFileSync(CHANGES_JSON, JSON.stringify(changesObj, null, 1), "utf-8");

  const activeCount = rows.filter((r) => r.status === "active").length;
  logs.push(
    `Roster updated: ${activeCount} active members, ${changes.length} changes${
      initial ? " (initial capture)" : ""
    }; ${noRoster.length} pages without a parsable roster`
  );

  return {
    rows,
    changes: changesObj,
    boardsScanned: boards.length,
    logs,
  };
}
