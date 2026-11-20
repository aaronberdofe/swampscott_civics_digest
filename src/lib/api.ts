export async function fetchJson<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 180);
      throw new Error(
        `Server returned non-JSON response (HTTP ${res.status}): ${snippet || res.statusText}`
      );
    }
  }
  if (!res.ok) {
    const errMsg =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `HTTP ${res.status} ${res.statusText}`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

interface JobPollResponse<T> {
  id: string;
  status: "running" | "done" | "error";
  logs: string[];
  result?: T;
  error?: string;
}

export async function runBackgroundJob<T>(
  endpoint: string,
  body: Record<string, unknown>,
  onLogs?: (logs: string[]) => void
): Promise<T> {
  const { jobId } = await fetchJson<{ jobId: string }>(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  while (true) {
    await new Promise((r) => setTimeout(r, 1200));
    const job = await fetchJson<JobPollResponse<T>>(
      `/api/jobs/${encodeURIComponent(jobId)}`
    );
    if (onLogs && Array.isArray(job.logs)) {
      onLogs(job.logs);
    }
    if (job.status === "done") {
      return job.result as T;
    }
    if (job.status === "error") {
      throw new Error(job.error || "Background job failed.");
    }
  }
}
