import "dotenv/config";
import fs from "node:fs";
import { backfillHistory } from "../server/digest.ts";
import {
  executeWeeklyPipeline,
  getZonedNow,
  loadSchedule,
  resolveBaseUrl,
  writeRssFile,
} from "../server/distribution.ts";

function setGithubOutput(key: string, value: string): void {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  fs.appendFileSync(outPath, `${key}=${value}\n`, "utf-8");
}

function getArgValue(args: string[], prefix: string): string | undefined {
  const exact = args.find((a) => a.startsWith(`${prefix}=`));
  if (exact) return exact.slice(prefix.length + 1).trim() || undefined;
  const idx = args.indexOf(prefix);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim() || undefined;
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const checkFridayEt = args.includes("--check-friday-et");
  const force = args.includes("--force");
  const skipEmail = args.includes("--skip-email");
  const rssOnly = args.includes("--rss-only");
  const backfillOnly = args.includes("--backfill");
  const dateOverride = getArgValue(args, "--date");
  const baseUrl = resolveBaseUrl();

  if (rssOnly) {
    writeRssFile(baseUrl);
    console.log(`Updated digests/rss.xml with base URL ${baseUrl}`);
    setGithubOutput("ran", "true");
    return;
  }

  const logs: string[] = [];
  const logPush = (line: string) => {
    logs.push(line);
    console.log(line);
  };
  const liveLogs = new Proxy(logs, {
    get(target, prop, receiver) {
      if (prop === "push") {
        return (...items: string[]) => {
          for (const item of items) console.log(item);
          return Array.prototype.push.apply(target, items);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  if (backfillOnly) {
    const lookbackDays = Number(getArgValue(args, "--lookback-days") || 365);
    const recentWeeks = Number(getArgValue(args, "--recent-weeks") || 8);
    logPush(
      `Starting historical backfill (lookbackDays=${lookbackDays}, recentWeeks=${recentWeeks})...`
    );
    const res = await backfillHistory(
      {
        endDate: dateOverride,
        lookbackDays,
        recentWeeks,
      },
      liveLogs
    );
    writeRssFile(baseUrl);
    console.log(
      `Backfill finished: ${res.generatedCount} generated, ${res.skippedCount} skipped, +${res.totalAddedVotes} votes.`
    );
    setGithubOutput("ran", "true");
    return;
  }

  const schedule = loadSchedule();
  const etNow = getZonedNow(schedule.timezone);

  if (checkFridayEt && !force) {
    if (etNow.weekday !== schedule.dayOfWeek) {
      console.log(
        `Skipping scheduled run: ET day is ${etNow.isoDate} (weekday=${etNow.weekday}), not Friday.`
      );
      setGithubOutput("ran", "false");
      return;
    }
    if (etNow.hour !== schedule.hour) {
      console.log(
        `Skipping scheduled run: current ET hour is ${String(etNow.hour).padStart(
          2,
          "0"
        )}:${String(etNow.minute).padStart(2, "0")} ${etNow.tzShort} (waiting for ${String(
          schedule.hour
        ).padStart(2, "0")}:00 ET).`
      );
      setGithubOutput("ran", "false");
      return;
    }
    if (schedule.lastScheduledDate === etNow.isoDate) {
      console.log(
        `Skipping scheduled run: already completed for ${etNow.isoDate}.`
      );
      setGithubOutput("ran", "false");
      return;
    }
  }

  const targetDate = dateOverride || etNow.isoDate;
  const result = await executeWeeklyPipeline({
    dateOverride: targetDate,
    baseUrl,
    scheduledDateTag: etNow.isoDate,
    skipEmail,
    logs: liveLogs,
  });

  console.log(
    `Done: ${result.outFile} | rssUpdated=${result.rssUpdated} | emailSent=${result.emailSent}`
  );
  if (result.emailError) {
    console.warn(`Email notice: ${result.emailError}`);
  }
  setGithubOutput("ran", "true");
  setGithubOutput("out_file", result.outFile);
}

main().catch((err) => {
  console.error("Weekly runner failed:", err);
  process.exit(1);
});
