import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { DIGEST_DIR, listDigests, VOTES_CSV } from "../server/digest.ts";
import { resolveBaseUrl, writeRssFile } from "../server/distribution.ts";
import { ROSTER_MD } from "../server/roster.ts";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "_site");

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractTitle(markdown: string, fallbackDate: string): string {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : `Swampscott Civic Digest — ${fallbackDate}`;
}

function renderPageShell(params: {
  title: string;
  description: string;
  rssHref: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(params.title)}</title>
    <meta name="description" content="${escapeHtml(params.description)}" />
    <link rel="alternate" type="application/rss+xml" title="Swampscott Civic Digest RSS" href="${escapeHtml(params.rssHref)}" />
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        background: #f5f4f0;
        color: #1c1917;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        line-height: 1.6;
      }
      header {
        background: #14213d;
        color: #ffffff;
        border-bottom: 3px solid #c99700;
      }
      .wrap {
        max-width: 880px;
        margin: 0 auto;
        padding: 20px 20px;
      }
      header h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      header p {
        margin: 6px 0 0;
        color: #cbd5e1;
        font-size: 14px;
      }
      .nav-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }
      .btn {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        border: 1px solid rgba(255,255,255,0.28);
        color: #ffffff;
        background: rgba(255,255,255,0.08);
      }
      .btn:hover { background: rgba(255,255,255,0.16); }
      .btn-primary {
        background: #ffffff;
        color: #14213d;
        border-color: #ffffff;
      }
      .card {
        background: #ffffff;
        border: 1px solid #d6d3d1;
        border-radius: 8px;
        padding: 24px;
        margin-top: 20px;
      }
      .rss-box {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        background: #fafaf9;
        border: 1px solid #e7e5e4;
        border-radius: 6px;
        padding: 12px 14px;
        margin-top: 12px;
      }
      .rss-box code {
        flex: 1 1 260px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        color: #14213d;
        word-break: break-all;
      }
      .edition-list {
        list-style: none;
        padding: 0;
        margin: 16px 0 0;
      }
      .edition-list li {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 12px 0;
        border-bottom: 1px solid #e7e5e4;
      }
      .edition-list li:last-child { border-bottom: none; }
      .edition-title {
        font-weight: 600;
        color: #14213d;
        text-decoration: none;
      }
      .edition-title:hover { text-decoration: underline; }
      .meta {
        font-size: 12px;
        color: #57534e;
      }
      .markdown h1, .markdown h2, .markdown h3 { color: #14213d; }
      .markdown h2 {
        border-bottom: 1px solid #e7e5e4;
        padding-bottom: 6px;
        margin-top: 28px;
      }
      .markdown table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
        font-size: 14px;
      }
      .markdown th, .markdown td {
        border: 1px solid #d6d3d1;
        padding: 8px 10px;
        text-align: left;
      }
      .markdown th { background: #fafaf9; }
      .markdown a { color: #1d4ed8; }
      footer {
        text-align: center;
        font-size: 12px;
        color: #57534e;
        padding: 24px 16px 40px;
      }
    </style>
  </head>
  <body>
    ${params.bodyHtml}
    <footer>
      Swampscott Civic Digest · Public RSS Feed &amp; Archive · Hosted on GitHub Pages
    </footer>
  </body>
</html>`;
}

function main() {
  const baseUrl = resolveBaseUrl();
  const rssXml = writeRssFile(baseUrl);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, "editions"), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "digests"), { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "", "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "rss.xml"), rssXml, "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "feed.xml"), rssXml, "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "digests", "rss.xml"), rssXml, "utf-8");

  if (fs.existsSync(VOTES_CSV)) {
    fs.copyFileSync(VOTES_CSV, path.join(OUT_DIR, "votes.csv"));
  }
  if (fs.existsSync(ROSTER_MD)) {
    fs.copyFileSync(ROSTER_MD, path.join(OUT_DIR, "roster.md"));
  }

  const digests = listDigests().filter(
    (d) => !d.isPrompt && /^\d{4}-\d{2}-\d{2}\.md$/.test(d.filename)
  );

  for (const d of digests) {
    const srcMd = path.join(DIGEST_DIR, d.filename);
    if (fs.existsSync(srcMd)) {
      fs.copyFileSync(srcMd, path.join(OUT_DIR, "digests", d.filename));
    }
    const title = extractTitle(d.content, d.date);
    const renderedHtml = String(marked.parse(d.content, { async: false, gfm: true }));
    const editionHtml = renderPageShell({
      title,
      description: `Swampscott Civic Digest for ${d.date}`,
      rssHref: "../rss.xml",
      bodyHtml: `
        <header>
          <div class="wrap">
            <h1>Swampscott Civic Digest</h1>
            <p>${escapeHtml(title)}</p>
            <div class="nav-bar">
              <a class="btn btn-primary" href="../index.html">← All Editions</a>
              <a class="btn" href="../rss.xml">RSS Feed</a>
              <a class="btn" href="../digests/${encodeURIComponent(d.filename)}">Raw Markdown</a>
            </div>
          </div>
        </header>
        <main class="wrap">
          <article class="card markdown">
            ${renderedHtml}
          </article>
        </main>
      `,
    });
    fs.writeFileSync(
      path.join(OUT_DIR, "editions", `${d.date}.html`),
      editionHtml,
      "utf-8"
    );
  }

  const feedUrlDisplay = `${baseUrl}/rss.xml`;
  const feedlyUrl = `https://feedly.com/i/subscription/feed/${encodeURIComponent(feedUrlDisplay)}`;

  const listItemsHtml = digests.length
    ? digests
        .map((d) => {
          const title = extractTitle(d.content, d.date);
          return `<li>
            <div>
              <a class="edition-title" href="./editions/${encodeURIComponent(d.date)}.html">${escapeHtml(title)}</a>
              <div class="meta">Edition date: ${escapeHtml(d.date)}</div>
            </div>
            <div class="meta">
              <a href="./editions/${encodeURIComponent(d.date)}.html">Read</a> ·
              <a href="./digests/${encodeURIComponent(d.filename)}">Markdown</a>
            </div>
          </li>`;
        })
        .join("\n")
    : `<li><span class="meta">No digest editions published yet. Run the Weekly Civic Digest workflow in GitHub Actions to generate your first edition.</span></li>`;

  const indexHtml = renderPageShell({
    title: "Swampscott Civic Digest — Archive & RSS",
    description:
      "Weekly summaries of Swampscott, MA town boards, committees, agendas, minutes, transcripts, and formal votes.",
    rssHref: "./rss.xml",
    bodyHtml: `
      <script>
        (function () {
          var q = new URLSearchParams(window.location.search).get("digest");
          if (q && /^\\d{4}-\\d{2}-\\d{2}\\.md$/.test(q)) {
            window.location.replace("./editions/" + q.replace(/\\.md$/, ".html"));
          }
        })();
      </script>
      <header>
        <div class="wrap">
          <h1>Swampscott Civic Digest</h1>
          <p>Weekly Friday 6:00 AM ET summaries of Swampscott, MA public meetings, votes &amp; planning context.</p>
          <div class="nav-bar">
            <a class="btn btn-primary" href="./rss.xml">Open RSS 2.0 Feed</a>
            <a class="btn" href="${escapeHtml(feedlyUrl)}" target="_blank" rel="noreferrer">Subscribe in Feedly</a>
            ${fs.existsSync(VOTES_CSV) ? '<a class="btn" href="./votes.csv">votes.csv</a>' : ""}
            ${fs.existsSync(ROSTER_MD) ? '<a class="btn" href="./roster.md">roster.md</a>' : ""}
          </div>
        </div>
      </header>
      <main class="wrap">
        <section class="card">
          <strong>Feedly / RSS Subscription URL</strong>
          <div class="rss-box">
            <code id="rss-url">${escapeHtml(feedUrlDisplay)}</code>
          </div>
        </section>
        <section class="card">
          <strong>Published Editions (${digests.length})</strong>
          <ul class="edition-list">
            ${listItemsHtml}
          </ul>
        </section>
      </main>
    `,
  });

  fs.writeFileSync(path.join(OUT_DIR, "index.html"), indexHtml, "utf-8");
  console.log(
    `Built static GitHub Pages site in _site/ (${digests.length} edition(s), RSS base URL: ${baseUrl}).`
  );
}

main();
