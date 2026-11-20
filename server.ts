import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import {
  backfillHistory,
  computeTally,
  fetchTranscriptByUrl,
  fetchTranscriptsMode,
  listDigests,
  listPlanningDocs,
  listSavedTranscripts,
  loadState,
  loadVotes,
  previewSources,
  runDigest,
  saveManualTranscript,
  VOTES_CSV,
} from "./server/digest.ts";
import {
  loadChangesJson,
  loadRoster,
  readRosterMarkdown,
  refreshRoster,
} from "./server/roster.ts";
import {
  buildRssXml,
  computeNextRunDisplay,
  executeWeeklyPipeline,
  getEmailConfigStatus,
  loadSchedule,
  resolveBaseUrl,
  saveSchedule,
  sendDigestEmail,
  startWeeklyScheduler,
  writeRssFile,
} from "./server/distribution.ts";

const PORT =
  process.env.NODE_ENV === "production"
    ? Number(process.env.PORT) || 3000
    : 3000;
const HOST = "0.0.0.0";

function getRequestOrigin(req: express.Request): string {
  const rawProto = req.headers["x-forwarded-proto"];
  const proto =
    (typeof rawProto === "string"
      ? rawProto.split(",")[0].trim()
      : Array.isArray(rawProto)
      ? rawProto[0]
      : "") || req.protocol || "https";
  const host = req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

interface JobRecord {
  id: string;
  status: "running" | "done" | "error";
  logs: string[];
  result?: unknown;
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, JobRecord>();

function startJob(
  runner: (logs: string[]) => Promise<unknown>
): string {
  // Prune completed jobs older than 1 hour
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status !== "running" && now - job.createdAt > 3_600_000) {
      jobs.delete(id);
    }
  }

  const id = crypto.randomUUID();
  const job: JobRecord = {
    id,
    status: "running",
    logs: [],
    createdAt: now,
  };
  jobs.set(id, job);

  runner(job.logs)
    .then((result) => {
      job.result = result;
      job.status = "done";
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      job.logs.push(`Error: ${msg}`);
      job.error = msg;
      job.status = "error";
    });

  return id;
}

async function startServer() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));

  // ---------------------------------------------------------------- API Routes
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found or expired." });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      logs: job.logs,
      result: job.status === "done" ? job.result : undefined,
      error: job.error,
    });
  });

  app.get("/api/overview", (_req, res) => {
    const roster = loadRoster();
    const activeRoster = roster.filter((r) => r.status === "active");
    const boards = new Set(activeRoster.map((r) => r.body));
    const changes = loadChangesJson();
    const digests = listDigests();
    const votes = loadVotes();
    const planning = listPlanningDocs();
    const transcripts = listSavedTranscripts();
    const state = loadState();

    res.json({
      activeMembersCount: activeRoster.length,
      totalRosterRows: roster.length,
      boardsCount: boards.size,
      rosterLastUpdated: changes?.date ?? null,
      recentChangesCount: changes?.changes?.length ?? 0,
      digestsCount: digests.filter((d) => !d.isPrompt).length,
      promptsCount: digests.filter((d) => d.isPrompt).length,
      votesCount: votes.length,
      planningDocsCount: planning.docs.length,
      planningChars: planning.totalChars,
      planningBudget: planning.budget,
      transcriptsCount: transcripts.length,
      seenKeysCount: state.seen.length,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  app.get("/api/roster", (_req, res) => {
    res.json({
      rows: loadRoster(),
      changes: loadChangesJson(),
      markdown: readRosterMarkdown(),
    });
  });

  app.post("/api/roster/refresh", (req, res) => {
    const dateOverride =
      typeof req.body?.date === "string" && req.body.date.trim()
        ? req.body.date.trim()
        : undefined;
    const jobId = startJob((logs) => refreshRoster(dateOverride, logs));
    res.status(202).json({ jobId });
  });

  app.get("/api/digests", (_req, res) => {
    res.json({ digests: listDigests() });
  });

  app.post("/api/digest/run", (req, res) => {
    const body = req.body || {};
    const reqOrigin = getRequestOrigin(req);
    const jobId = startJob(async (logs) => {
      const result = await runDigest(
        {
          date:
            typeof body.date === "string" && body.date.trim()
              ? body.date.trim()
              : undefined,
          promptOnly: Boolean(body.promptOnly),
          dryRun: Boolean(body.dryRun),
          ignoreState: Boolean(body.ignoreState),
          skipYtFetch: Boolean(body.skipYtFetch),
        },
        logs
      );
      if (!result.promptOnly) {
        writeRssFile(resolveBaseUrl(reqOrigin));
        logs.push("Updated public RSS feed (/rss.xml).");
        if (Boolean(body.sendEmail) && !result.dryRun) {
          const fname = result.outFile.replace(/^digests\//, "");
          await sendDigestEmail({
            filename: fname,
            baseUrl: resolveBaseUrl(reqOrigin),
            logs,
          });
        }
      }
      return result;
    });
    res.status(202).json({ jobId });
  });

  app.post("/api/digest/backfill", (req, res) => {
    const body = req.body || {};
    const reqOrigin = getRequestOrigin(req);
    const jobId = startJob(async (logs) => {
      const result = await backfillHistory(
        {
          endDate:
            typeof body.endDate === "string" && body.endDate.trim()
              ? body.endDate.trim()
              : undefined,
          lookbackDays:
            body.lookbackDays !== undefined ? Number(body.lookbackDays) : undefined,
          recentWeeks:
            body.recentWeeks !== undefined ? Number(body.recentWeeks) : undefined,
          overwrite: Boolean(body.overwrite),
          dryRun: Boolean(body.dryRun),
        },
        logs
      );
      if (!result.dryRun && result.generatedCount > 0) {
        writeRssFile(resolveBaseUrl(reqOrigin));
        logs.push("Updated public RSS feed (/rss.xml).");
      }
      return result;
    });
    res.status(202).json({ jobId });
  });

  // ---------------------------------------------------------------- Schedule, RSS & Email
  app.get(["/rss.xml", "/feed.xml"], (req, res) => {
    const reqOrigin = getRequestOrigin(req);
    const xml = buildRssXml(resolveBaseUrl(reqOrigin));
    res
      .status(200)
      .set("Content-Type", "application/rss+xml; charset=utf-8")
      .set("Cache-Control", "public, max-age=300")
      .send(xml);
  });

  app.get("/api/schedule", (_req, res) => {
    const schedule = loadSchedule();
    const next = computeNextRunDisplay(schedule);
    res.json({
      schedule,
      ...next,
      email: getEmailConfigStatus(),
      rssPath: "/rss.xml",
      cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    });
  });

  app.post("/api/schedule", (req, res) => {
    const body = req.body || {};
    const patch: Record<string, boolean> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.refreshRosterFirst === "boolean") {
      patch.refreshRosterFirst = body.refreshRosterFirst;
    }
    if (typeof body.sendEmailAfterRun === "boolean") {
      patch.sendEmailAfterRun = body.sendEmailAfterRun;
    }
    const schedule = saveSchedule(patch);
    const next = computeNextRunDisplay(schedule);
    res.json({
      schedule,
      ...next,
      email: getEmailConfigStatus(),
      rssPath: "/rss.xml",
      cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    });
  });

  app.post("/api/email/send", (req, res) => {
    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : undefined;
    const reqOrigin = getRequestOrigin(req);
    const jobId = startJob((logs) =>
      sendDigestEmail({
        filename,
        baseUrl: resolveBaseUrl(reqOrigin),
        logs,
      })
    );
    res.status(202).json({ jobId });
  });

  app.post("/api/schedule/run-now", (req, res) => {
    const reqOrigin = getRequestOrigin(req);
    const dateOverride =
      typeof req.body?.date === "string" && req.body.date.trim()
        ? req.body.date.trim()
        : undefined;
    const jobId = startJob((logs) =>
      executeWeeklyPipeline({
        dateOverride,
        baseUrl: resolveBaseUrl(reqOrigin),
        logs,
      })
    );
    res.status(202).json({ jobId });
  });

  app.post("/api/cron/weekly-digest", async (req, res) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (secret) {
      const authHeader = String(req.headers.authorization || "");
      const cronHeader = String(req.headers["x-cron-secret"] || "");
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : cronHeader.trim();
      if (token !== secret) {
        res.status(401).json({ error: "Unauthorized cron trigger." });
        return;
      }
    }
    const reqOrigin = getRequestOrigin(req);
    const ua = String(req.headers["user-agent"] || "");
    const shouldWait =
      req.query.wait === "true" ||
      req.query.wait === "1" ||
      req.query.sync === "true" ||
      req.query.sync === "1" ||
      req.body?.wait === true ||
      req.body?.sync === true ||
      /Google-Cloud-Scheduler/i.test(ua);

    if (shouldWait) {
      try {
        const result = await executeWeeklyPipeline({
          baseUrl: resolveBaseUrl(reqOrigin),
          logs: [],
        });
        res.status(200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
      return;
    }

    const jobId = startJob((logs) =>
      executeWeeklyPipeline({
        baseUrl: resolveBaseUrl(reqOrigin),
        logs,
      })
    );
    res.status(202).json({ jobId });
  });

  app.get("/api/sources/preview", async (req, res) => {
    try {
      const dateOverride =
        typeof req.query.date === "string" && req.query.date.trim()
          ? req.query.date.trim()
          : undefined;
      const preview = await previewSources(dateOverride);
      res.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/votes", (_req, res) => {
    const votes = loadVotes();
    const tally = computeTally(votes);
    res.json({ votes, tally });
  });

  app.get("/api/votes/csv", (_req, res) => {
    if (!fs.existsSync(VOTES_CSV)) {
      res
        .status(200)
        .type("text/csv")
        .send("meeting_date,body,item,motion,result,yes,no,abstain,source\n");
      return;
    }
    res.download(VOTES_CSV, "votes.csv");
  });

  app.get("/api/planning-docs", (_req, res) => {
    res.json(listPlanningDocs());
  });

  app.get("/api/transcripts", (_req, res) => {
    res.json({ transcripts: listSavedTranscripts() });
  });

  app.post("/api/transcripts/fetch", (req, res) => {
    const dateOverride =
      typeof req.body?.date === "string" && req.body.date.trim()
        ? req.body.date.trim()
        : undefined;
    const jobId = startJob((logs) => fetchTranscriptsMode(dateOverride, logs));
    res.status(202).json({ jobId });
  });

  app.post("/api/transcripts/fetch-url", (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "YouTube URL or video ID is required." });
      return;
    }
    const jobId = startJob(async (logs) => {
      const result = await fetchTranscriptByUrl(url, logs);
      return { ...result, transcripts: listSavedTranscripts() };
    });
    res.status(202).json({ jobId });
  });

  app.post("/api/transcripts/add", (req, res) => {
    try {
      const { title, url, published, text } = req.body || {};
      if (typeof text !== "string" || !text.trim()) {
        res.status(400).json({ error: "Transcript text is required." });
        return;
      }
      const item = saveManualTranscript({
        title: typeof title === "string" ? title : "Meeting Transcript",
        url: typeof url === "string" ? url : "",
        published:
          typeof published === "string"
            ? published
            : new Date().toISOString().slice(0, 10),
        text,
      });
      res.json({ item, transcripts: listSavedTranscripts() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Always return JSON for /api/* errors
  app.use(
    "/api",
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message || "Internal server error" });
    }
  );

  const httpServer = http.createServer(app);
  httpServer.requestTimeout = 0;

  // ---------------------------------------------------------------- Vite / Static
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== "true",
        ws: { server: httpServer },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`Swampscott Civic Digest listening on http://${HOST}:${PORT}`);
    startWeeklyScheduler();
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
