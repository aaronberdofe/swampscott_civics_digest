import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import nodemailer from "nodemailer";
import { DIGEST_DIR, listDigests, runDigest } from "./digest.ts";
import { refreshRoster } from "./roster.ts";

const ROOT = process.cwd();
export const SCHEDULE_FILE = path.join(ROOT, "schedule.json");
export const RSS_FILE = path.join(DIGEST_DIR, "rss.xml");

export interface ScheduleConfig {
  enabled: boolean;
  dayOfWeek: number; // 5 = Friday
  hour: number; // 6 (6:00 AM)
  minute: number; // 0
  timezone: string; // America/New_York
  refreshRosterFirst: boolean;
  sendEmailAfterRun: boolean;
  lastScheduledDate: string | null;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "done" | "error";
  lastRunMessage: string | null;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  enabled: true,
  dayOfWeek: 5,
  hour: 6,
  minute: 0,
  timezone: "America/New_York",
  refreshRosterFirst: true,
  sendEmailAfterRun: true,
  lastScheduledDate: null,
  lastRunAt: null,
  lastRunStatus: "idle",
  lastRunMessage: null,
};

export function loadSchedule(): ScheduleConfig {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    return { ...DEFAULT_SCHEDULE };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
    return {
      ...DEFAULT_SCHEDULE,
      ...parsed,
      dayOfWeek: 5,
      hour: 6,
      minute: 0,
      timezone: "America/New_York",
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export function saveSchedule(patch: Partial<ScheduleConfig>): ScheduleConfig {
  const current = loadSchedule();
  const next: ScheduleConfig = {
    ...current,
    ...patch,
    dayOfWeek: 5,
    hour: 6,
    minute: 0,
    timezone: "America/New_York",
  };
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedNow {
  isoDate: string;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  tzShort: string;
}

export function getZonedNow(
  timeZone = "America/New_York",
  now = new Date()
): ZonedNow {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const wd = WEEKDAY_MAP[get("weekday")] ?? 0;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get("minute"), 10);
  const second = parseInt(get("second"), 10);
  const tzShort = get("timeZoneName") || "ET";
  return {
    isoDate: `${year}-${month}-${day}`,
    weekday: wd,
    hour,
    minute,
    second,
    tzShort,
  };
}

export function computeNextRunDisplay(config = loadSchedule()): {
  nextRunDate: string;
  nextRunDisplay: string;
} {
  const now = getZonedNow(config.timezone);
  let daysAhead = (config.dayOfWeek - now.weekday + 7) % 7;
  const pastTimeToday =
    now.hour > config.hour ||
    (now.hour === config.hour && now.minute >= config.minute);
  if (daysAhead === 0 && (pastTimeToday || config.lastScheduledDate === now.isoDate)) {
    daysAhead = 7;
  }
  const d = new Date(`${now.isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  const nextDate = d.toISOString().slice(0, 10);
  const pretty = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const hh = String(config.hour).padStart(2, "0");
  const mm = String(config.minute).padStart(2, "0");
  const ampm = config.hour >= 12 ? "PM" : "AM";
  const h12 = config.hour % 12 || 12;
  return {
    nextRunDate: nextDate,
    nextRunDisplay: `${pretty} at ${h12}:${mm} ${ampm} ET (${hh}:${mm} ${config.timezone})`,
  };
}

// ---------------------------------------------------------------- Base URL
export function resolveBaseUrl(reqOrigin?: string): string {
  const explicitPublic = (process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (explicitPublic && /^https?:\/\//i.test(explicitPublic)) {
    return explicitPublic;
  }
  const cleanOrigin = reqOrigin ? reqOrigin.trim().replace(/\/+$/, "") : "";
  if (
    cleanOrigin &&
    /^https?:\/\//i.test(cleanOrigin) &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleanOrigin)
  ) {
    return cleanOrigin;
  }
  const envUrl = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (envUrl && envUrl !== "MY_APP_URL" && /^https?:\/\//i.test(envUrl)) {
    return envUrl;
  }
  if (cleanOrigin && /^https?:\/\//i.test(cleanOrigin)) {
    return cleanOrigin;
  }
  return "http://localhost:3000";
}

// ---------------------------------------------------------------- RSS 2.0 Feed
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractDigestTitle(content: string, fallbackDate: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : `Swampscott Civic Digest — ${fallbackDate}`;
}

function extractPlainExcerpt(content: string, maxLen = 420): string {
  const plain = content
    .replace(/^#.*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen - 1)}…` : plain;
}

function rfc2822ForDate(dateIso: string, fallbackIso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    // 06:00 AM America/New_York (~11:00 UTC in EST / 10:00 UTC in EDT)
    const d = new Date(`${dateIso}T11:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d.toUTCString();
  }
  const f = new Date(fallbackIso);
  return Number.isNaN(f.getTime()) ? new Date().toUTCString() : f.toUTCString();
}

export function buildRssXml(baseUrl = resolveBaseUrl()): string {
  const digests = listDigests()
    .filter((d) => !d.isPrompt && /^\d{4}-\d{2}-\d{2}\.md$/.test(d.filename))
    .slice(0, 52);

  const feedLink = `${baseUrl}/rss.xml`;
  const lastBuildDate = digests.length
    ? rfc2822ForDate(digests[0].date, digests[0].updatedAt)
    : new Date().toUTCString();

  const itemsXml = digests
    .map((d) => {
      const title = extractDigestTitle(d.content, d.date);
      const htmlBody = String(
        marked.parse(d.content, { async: false, gfm: true })
      );
      const safeHtml = htmlBody.replace(/\]\]>/g, "]]]]><![CDATA[>");
      const excerpt = extractPlainExcerpt(d.content);
      const itemLink = `${baseUrl}/?digest=${encodeURIComponent(d.filename)}`;
      const guid = `swampscott-civic-digest-${d.date}`;
      const pubDate = rfc2822ForDate(d.date, d.updatedAt);

      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(itemLink)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <description>${escapeXml(excerpt)}</description>
      <content:encoded><![CDATA[${safeHtml}]]></content:encoded>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Swampscott Civic Digest</title>
    <link>${escapeXml(baseUrl)}</link>
    <atom:link href="${escapeXml(feedLink)}" rel="self" type="application/rss+xml" />
    <description>Weekly summaries of Swampscott, MA town boards, committees, agendas, minutes, transcripts, and formal votes.</description>
    <language>en-us</language>
    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>
    <ttl>60</ttl>
${itemsXml}
  </channel>
</rss>
`;
}

export function writeRssFile(baseUrl = resolveBaseUrl()): string {
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  const xml = buildRssXml(baseUrl);
  fs.writeFileSync(RSS_FILE, xml, "utf-8");
  return xml;
}

// ---------------------------------------------------------------- Free Email Delivery
export interface EmailConfigStatus {
  configured: boolean;
  provider: "smtp" | "brevo" | "resend" | "none";
  recipientHint: string | null;
}

export function getEmailConfigStatus(): EmailConfigStatus {
  const emailTo = (process.env.EMAIL_TO || "").trim();
  const hasSmtp = Boolean(
    process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim()
  );
  const hasBrevo = Boolean(
    process.env.BREVO_API_KEY?.trim() &&
      (process.env.EMAIL_FROM?.trim() || process.env.SMTP_USER?.trim())
  );
  const hasResend = Boolean(process.env.RESEND_API_KEY?.trim());

  let provider: EmailConfigStatus["provider"] = "none";
  if (hasSmtp) provider = "smtp";
  else if (hasBrevo) provider = "brevo";
  else if (hasResend) provider = "resend";

  const maskedTo = emailTo
    ? emailTo
        .split(",")
        .map((addr) => {
          const clean = addr.trim();
          const [local, dom] = clean.split("@");
          if (!dom) return clean;
          const prefix = local.slice(0, 2);
          return `${prefix}***@${dom}`;
        })
        .join(", ")
    : null;

  return {
    configured: Boolean(emailTo && provider !== "none"),
    provider,
    recipientHint: maskedTo,
  };
}

function renderEmailHtml(
  title: string,
  markdown: string,
  rssUrl: string,
  baseUrl: string
): string {
  const rendered = String(marked.parse(markdown, { async: false, gfm: true }));
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;">
    <div style="max-width:680px;margin:24px auto;background:#ffffff;border:1px solid #d6d3d1;border-radius:8px;overflow:hidden;">
      <div style="background:#14213d;color:#ffffff;padding:20px 24px;">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#cbd5e1;">Swampscott Civic Digest</div>
        <h1 style="margin:6px 0 0;font-size:20px;line-height:1.3;font-weight:600;">${escapeXml(title)}</h1>
      </div>
      <div style="padding:24px;font-size:14px;line-height:1.65;color:#292524;">
        ${rendered}
      </div>
      <div style="border-top:1px solid #e7e5e4;background:#fafaf9;padding:14px 24px;font-size:12px;color:#57534e;">
        <a href="${escapeXml(baseUrl)}" style="color:#14213d;font-weight:600;text-decoration:none;">Open Digest App</a>
        &nbsp;·&nbsp;
        <a href="${escapeXml(rssUrl)}" style="color:#14213d;font-weight:600;text-decoration:none;">RSS Feed</a>
      </div>
    </div>
  </body>
</html>`;
}

export async function sendDigestEmail(params: {
  filename?: string;
  baseUrl?: string;
  logs?: string[];
}): Promise<{
  sent: boolean;
  provider: string;
  recipient: string;
  subject: string;
  messageId?: string;
}> {
  const logs = params.logs ?? [];
  const emailTo = (process.env.EMAIL_TO || "").trim();
  if (!emailTo) {
    throw new Error(
      "EMAIL_TO is not configured. Add EMAIL_TO (your email address) in Settings > Secrets."
    );
  }

  const all = listDigests().filter((d) => !d.isPrompt);
  const target = params.filename
    ? all.find((d) => d.filename === params.filename)
    : all[0];
  if (!target) {
    throw new Error("No digest markdown file available to email.");
  }

  const baseUrl = resolveBaseUrl(params.baseUrl);
  const rssUrl = `${baseUrl}/rss.xml`;
  const subject = extractDigestTitle(target.content, target.date);
  const html = renderEmailHtml(subject, target.content, rssUrl, baseUrl);
  const text = `${target.content}\n\n---\nWeb App: ${baseUrl}\nRSS Feed: ${rssUrl}\n`;

  const status = getEmailConfigStatus();
  if (status.provider === "none") {
    throw new Error(
      "No email delivery secret is configured. Add SMTP_USER + SMTP_PASS (Gmail App Password), BREVO_API_KEY, or RESEND_API_KEY in Settings > Secrets."
    );
  }

  if (status.provider === "smtp") {
    const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
    const port = Number(process.env.SMTP_PORT || 465);
    const user = process.env.SMTP_USER!.trim();
    const pass = process.env.SMTP_PASS!.trim();
    const from = process.env.SMTP_FROM?.trim() || process.env.EMAIL_FROM?.trim() || user;

    logs.push(`Sending digest email (${target.filename}) via SMTP (${host})...`);
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    const info = await transporter.sendMail({
      from: `Swampscott Civic Digest <${from}>`,
      to: emailTo,
      subject,
      text,
      html,
    });
    logs.push(`Email sent via SMTP (messageId: ${info.messageId})`);
    return {
      sent: true,
      provider: "smtp",
      recipient: status.recipientHint || emailTo,
      subject,
      messageId: info.messageId,
    };
  }

  if (status.provider === "brevo") {
    const apiKey = process.env.BREVO_API_KEY!.trim();
    const senderEmail = (
      process.env.EMAIL_FROM ||
      process.env.SMTP_USER ||
      ""
    ).trim();
    const toList = emailTo
      .split(",")
      .map((e) => ({ email: e.trim() }))
      .filter((x) => x.email);

    logs.push(`Sending digest email (${target.filename}) via Brevo HTTP API...`);
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Swampscott Civic Digest", email: senderEmail },
        to: toList,
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`Brevo API HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    const parsed = JSON.parse(bodyText || "{}") as { messageId?: string };
    logs.push(`Email sent via Brevo (messageId: ${parsed.messageId || "ok"})`);
    return {
      sent: true,
      provider: "brevo",
      recipient: status.recipientHint || emailTo,
      subject,
      messageId: parsed.messageId,
    };
  }

  // Resend fallback
  const apiKey = process.env.RESEND_API_KEY!.trim();
  const fromEmail =
    process.env.EMAIL_FROM?.trim() || "Swampscott Civic Digest <onboarding@resend.dev>";
  const toArr = emailTo
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  logs.push(`Sending digest email (${target.filename}) via Resend HTTP API...`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: toArr,
      subject,
      html,
      text,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Resend API HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const parsed = JSON.parse(bodyText || "{}") as { id?: string };
  logs.push(`Email sent via Resend (id: ${parsed.id || "ok"})`);
  return {
    sent: true,
    provider: "resend",
    recipient: status.recipientHint || emailTo,
    subject,
    messageId: parsed.id,
  };
}

// ---------------------------------------------------------------- Weekly Pipeline & Friday 6AM ET Scheduler
let pipelineActive = false;

export async function executeWeeklyPipeline(params: {
  dateOverride?: string;
  baseUrl?: string;
  scheduledDateTag?: string;
  skipEmail?: boolean;
  logs?: string[];
}): Promise<{
  date: string;
  outFile: string;
  rssUpdated: boolean;
  emailSent: boolean;
  emailError?: string;
  logs: string[];
}> {
  const logs = params.logs ?? [];
  if (pipelineActive) {
    throw new Error("A weekly digest pipeline run is already in progress.");
  }
  pipelineActive = true;
  const config = loadSchedule();
  const etNow = getZonedNow(config.timezone);
  const targetDate = params.dateOverride || etNow.isoDate;
  const baseUrl = resolveBaseUrl(params.baseUrl);

  saveSchedule({
    lastRunStatus: "running",
    lastRunAt: new Date().toISOString(),
    lastRunMessage: `Running weekly pipeline for ${targetDate}...`,
  });

  try {
    logs.push(
      `Starting weekly pipeline for ${targetDate} (Friday 6:00 AM ET schedule)...`
    );

    if (config.refreshRosterFirst) {
      try {
        logs.push("Step 1/4: Refreshing town board & committee roster...");
        await refreshRoster(targetDate, logs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`Roster refresh warning (continuing digest): ${msg}`);
      }
    }

    logs.push(`Step 2/4: Generating weekly digest (${targetDate})...`);
    const digestResult = await runDigest({ date: targetDate }, logs);

    logs.push("Step 3/4: Publishing updated public RSS feed (/rss.xml)...");
    writeRssFile(baseUrl);

    let emailSent = false;
    let emailError: string | undefined;
    const latestConfig = loadSchedule();
    if (params.skipEmail) {
      logs.push("Step 4/4: Email delivery skipped (--skip-email).");
    } else if (latestConfig.sendEmailAfterRun) {
      const emailStatus = getEmailConfigStatus();
      if (!emailStatus.configured) {
        emailError =
          "Skipped email: configure EMAIL_TO and SMTP_USER/SMTP_PASS (or BREVO_API_KEY / RESEND_API_KEY) in Settings > Secrets.";
        logs.push(`Step 4/4: ${emailError}`);
      } else {
        try {
          logs.push("Step 4/4: Sending weekly digest email...");
          const fname = digestResult.outFile.replace(/^digests\//, "");
          await sendDigestEmail({ filename: fname, baseUrl, logs });
          emailSent = true;
        } catch (err) {
          emailError = err instanceof Error ? err.message : String(err);
          logs.push(`Step 4/4 email warning: ${emailError}`);
        }
      }
    } else {
      logs.push("Step 4/4: Email delivery after run is disabled in schedule settings.");
    }

    const summaryMsg = `Generated ${digestResult.outFile}, updated /rss.xml${
      emailSent ? ", and emailed digest" : emailError ? " (email skipped/warning)" : ""
    }.`;
    saveSchedule({
      lastScheduledDate: params.scheduledDateTag || targetDate,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "done",
      lastRunMessage: summaryMsg,
    });
    logs.push(`Pipeline complete: ${summaryMsg}`);

    return {
      date: targetDate,
      outFile: digestResult.outFile,
      rssUpdated: true,
      emailSent,
      emailError,
      logs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    saveSchedule({
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "error",
      lastRunMessage: msg,
    });
    throw err;
  } finally {
    pipelineActive = false;
  }
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startWeeklyScheduler(): void {
  if (schedulerTimer) return;

  // Ensure initial RSS file exists on disk at startup
  try {
    writeRssFile(resolveBaseUrl());
  } catch {
    // non-fatal
  }

  schedulerTimer = setInterval(() => {
    const config = loadSchedule();
    if (!config.enabled || pipelineActive) return;

    const now = getZonedNow(config.timezone);
    const isTargetDay = now.weekday === config.dayOfWeek; // Friday = 5
    const isPastTargetTime =
      now.hour > config.hour ||
      (now.hour === config.hour && now.minute >= config.minute);

    if (
      isTargetDay &&
      isPastTargetTime &&
      config.lastScheduledDate !== now.isoDate
    ) {
      const logs: string[] = [];
      console.log(
        `[Scheduler] Triggering scheduled Friday 6:00 AM ET weekly digest for ${now.isoDate}...`
      );
      executeWeeklyPipeline({
        dateOverride: now.isoDate,
        scheduledDateTag: now.isoDate,
        logs,
      }).catch((err) => {
        console.error("[Scheduler] Weekly digest pipeline failed:", err);
      });
    }
  }, 30_000);

  if (typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }
}
