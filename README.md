Swampscott Civic Digest

Weekly (Friday morning) summary of public meetings: YouTube transcripts + Agenda Center agendas/minutes + your planning documents -> Gemini -> digests/YYYY-MM-DD.md, plus a running votes.csv tally.

Setup (about 15 minutes)
Create a public GitHub repo (unlimited free Actions minutes) and push this folder.
Put your planning documents (.md, .txt, .pdf) in planning_docs/.
Get a free key at https://aistudio.google.com/apikey.
Repo -> Settings -> Secrets and variables -> Actions -> add secret GEMINI_API_KEY.
Optional: secrets SMTP_USER, SMTP_PASS (Gmail app password), EMAIL_TO for email; variable CHANNEL_ID if auto-detection of the YouTube channel fails.
Actions tab -> "Weekly civic digest" -> Run workflow to test.
Board/committee roster (runs first)

roster.py is its own workflow step that runs before the digest. It reads the town's sitemap, visits every page under "Boards & Committees", and parses each "Members" table (name, role such as Chair, seat, term expiration; emails are not collected). Output:

roster.csv: the maintained table (status active/departed, first_seen, last_seen)
roster.md: readable per-board tables
roster_changes.json: joins, departures and role/term changes, shown in the weekly digest

The roster is also passed to the LLM so it can correct misspelled names in auto-captions. If a board page can't be parsed, its previous rows are kept (nobody is marked departed by mistake). The first run records everyone without reporting them as "changes". Boards with no parsable Members section are listed in roster_changes.json under no_roster_found.

Test locally first
bash
pip install -r requirements.txt
export GEMINI_API_KEY=...
python civic_digest.py --dry-run --ignore-state
python civic_digest.py --prompt-only      # writes a prompt to paste into any chat LLM
Transcripts: YouTube blocks GitHub's servers

GitHub Actions runs on cloud IPs, which YouTube blocks. So transcripts are fetched from your own computer and committed to the repo; the Friday workflow then reads them from transcripts/.

Each week (Thursday evening or Friday before 7am), on your own computer:

bash
git pull
python civic_digest.py --fetch-transcripts     # saves meeting transcripts to transcripts/
git add transcripts && git commit -m "Transcripts" && git push

Only videos on the channel's Live tab (youtube.com/@townofswampscott/streams) are used; regular uploads such as sports are ignored. As a second safeguard, live streams whose titles match sports keywords are also skipped (change with SKIP_TITLE_REGEX). If the Live tab can't be read (for example, YouTube changes its page layout), the script fetches no transcripts and says so in the log rather than falling back to all uploads; set LIVE_ONLY=0 to include every upload. If you forget a week, the digest still runs from agendas and minutes.

Other settings
Gemini models: several are tried in order until one works. To force one, add a repo variable (not secret) named GEMINI_MODEL. The log prints the models your key can call.
Planning documents: only .md and .txt files in planning_docs/ are loaded. Full PDFs are ignored (set INCLUDE_PDFS=1 to include them) so they don't use up the character budget. Keep PDFs elsewhere in the repo, or out of it.
Things to verify on first run
Agenda Center scraping assumes standard CivicPlus links (/AgendaCenter/ViewFile/Agenda/_MMDDYYYY-ID). Check the log line "found N agenda/minutes links" and that board names look right.
Transcripts: YouTube may block GitHub's cloud IPs. If transcripts fail in Actions but work locally, run the script from your own machine with cron instead.
Model name: default is gemini-2.5-flash; override with GEMINI_MODEL if it is retired.
Free-tier limits: if you hit token or rate limits, lower PLAN_CHAR_BUDGET and TRANSCRIPT_CHAR_CAP, or use --prompt-only.
Minutes lag: minutes are usually posted weeks after a meeting, so the digest includes newly posted minutes (tracked in state.json) alongside this week's agendas and transcripts.
