# rred

Authorized **purple-team** security assessment by the FIAP security team
against the **Nano Courses** platform (`https://on.fiap.com.br/nano-courses/*`
and, in phase 2, `https://on.fiap.com.br/mod/quiz/*`), executed on
2026-10-05 against a test account provided by the team itself.

> **Repo description:** Authorized purple-team assessment of FIAP ON Nano
> Courses — automated 0→100% progress, AI-solved certification exams,
> credits/certificates earned autonomously, and the countermeasures to stop it.

## Questions

1. Can a Nano Course be driven from 0% to 100% with the student doing
   absolutely nothing — no video watching, no browser, no interaction?
2. Can the **certification exam** that unlocks certificates and credits also
   be automated (e.g., with an AI answering)?

## Answers

**1 — Yes, in seconds.** Proven in production with plain HTTP:

| Target (nano) | Initial state | Result | Time (incl. login) |
|---|---|---|---|
| Big Data (15350) | `[100,0,0,0,0,0]` | 6/6 chapters at 100% | **6.4 s** |
| Future-Proof (15385), untouched | `[0,0,0,0]` + not enrolled | enrolled + 4/4 chapters (22 videos) | **8.5 s** |

Root cause: video progress is **declared by the client**
(`local_fiapws_set_visualizacao`) and the server accepts any `lastSecond`
with no temporal plausibility check.

**2 — Yes, with a perfect score.** Using an automated browser
(Puppeteer-equivalent) + **DeepSeek** answering every question:

| Metric | Value |
|---|---|
| Grade (20 questions, 1st attempt) | **100.00 / 100.00** |
| Certificate | **issued** |
| Credits | **6 granted** (account started the day at 0) |
| Duration | ~10 min (optimizable to ~2 min) |

**Phase 3 — standalone solver (`rred-exam.mjs`, Puppeteer + headless Edge)
and the credits goal:**

| Autonomous run (one command each) | Result |
|---|---|
| Agentic AI: HTTP 0→100% (~9 s) + `rred-exam.mjs` | grade 100.00 → 6 credits |
| After Effects & Premiere: HTTP 0→100% (11 s, 49 videos) + `rred-exam.mjs` | grade 90.00 (29 questions, **109.6 s** incl. login) → 15 credits |

**Phase 4 — fully autonomous 0→N pipeline (`rred-auto.mjs`).** A single
command: while credits < target → pick the best nano (most credits, fewest
chapters, has an exam) → HTTP enroll + 0→100% → wait for the exam gate
(async aggregator, handled with polling) → solve the exam with the Puppeteer
solver → check credits → repeat. Production validation:

| Run | Path | Time |
|---|---|---|
| `--target 30` | 21 → **39 credits** (18-credit nano: already 100% + autonomous 95.00 exam) | **109.3 s** |

From a clean account, 0→20+ credits takes ~2–5 minutes and cents of API
spend. Every credit-generating transition (enrollment, 0→100%, exam,
approval) ran autonomously at least once during this assessment.

Full chain attacked: `login → enroll → 0→100% (HTTP, ~10 s) → exam with LLM
(Puppeteer, ~2 min) → certificate + credits`. Zero content was actually
consumed at any step.

Controls absent across the entire flow: captcha, 2FA, perceptible rate
limiting, telemetry/fingerprinting, server-side time validation. The only
pacing control observed: a retake cooldown after a zeroed grade, and an
incidental async propagation delay on the exam gate.

## Repository layout

- `cli.mjs` — presentation CLI: animated banner + interactive menu.
- `scripts/rred.js` — phase 1 PoC: 0→100% progress (Node 24, no deps).
- `scripts/rred-auto.mjs` — phase 4: autonomous 0→N credits pipeline
  (nano selection + HTTP 0→100% + gate polling + Puppeteer solver).
- `scripts/rred-exam.mjs` — phase 3: standalone exam solver
  (puppeteer-core + system Edge/Chrome + DeepSeek/OpenAI). Login,
  preflight, single/multi questions, finish, grade — one command.
- `scripts/rred-quiz.js` + `scripts/quiz-parse.js` — pure-HTTP exam replica
  (experiment; see limitation in TECHNICAL_ANALYSIS §6.4).
- `scripts/quiz-page-answer.mjs` — parse+LLM+body helper (phase 2).
- [`docs/TECHNICAL_ANALYSIS.md`](docs/TECHNICAL_ANALYSIS.md) — full attack
  chain, endpoints, evidence, limitations (red-team side).
- [`docs/COUNTERMEASURES.md`](docs/COUNTERMEASURES.md) — prevention,
  detection, log signatures (blue-team side).

Dependency: `npm install puppeteer-core` (uses the system Edge/Chrome; no
browser download).

## Usage

```bash
node cli.mjs                    # animated banner + interactive menu
node cli.mjs status             # credits + nano overview
node cli.mjs auto --target 20   # full pipeline: from current credits to 20

# or step by step:
node scripts/rred.js --course 15347        # 1) enroll + 0→100% (~10 s)
node scripts/rred-exam.mjs --cmid 568460   # 2) autonomous exam (~2 min) → grade
```

### Providing your portal credentials (3 ways, in precedence order)

1. **Interactively** — easiest: just run any command without credentials
   set and it will prompt for the portal username (RM) and password
   (password input is hidden). It offers to save them to `.env` for next
   time. Only asks for the LLM key when a command actually needs it
   (exam / auto-pilot).
2. **`.env` file** — copy `.env.example` to `.env` and fill in:
   ```ini
   RRED_RM=123456
   RRED_PASSWORD="your-password"
   DEEPSEEK_API_KEY="sk-..."
   ```
   `.env` is gitignored and never committed.
3. **Environment variables** — `RRED_RM`, `RRED_PASSWORD`,
   `DEEPSEEK_API_KEY` (or `OPENAI_API_KEY`).

Solver flags: `--headed` (watch it run), `--provider openai` (fallback),
`--model <id>`. Orchestrator flags: `--target N`, `--max-nanos K`.
Banner: disable with `--no-banner` or `RRED_NO_BANNER=1` (recommended on
terminals without ANSI support).

## Scope and authorization

- Scope: `https://on.fiap.com.br/nano-courses/*` and
  `https://on.fiap.com.br/mod/quiz/*`, plus the direct supporting endpoints
  (platform login and the AJAX webservices used by that flow).
- Test account and API keys (DeepSeek/OpenAI, FIAP-funded) provided by the
  security team; no real student data was accessed; keys kept outside the
  repository.
- Not tested: third-party credentials, mandatory-nano gate bypass (the
  account had already completed it), answer harvesting via review (the skin
  does not expose it), or other platform courses/plugins.
