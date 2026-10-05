# Technical analysis — Nano Courses automation (red-team side)

Date: 2026-10-05 · Scope: `https://on.fiap.com.br/nano-courses/*` +
`https://on.fiap.com.br/mod/quiz/*` (phase 2) · Security team test account.

## 1. Target architecture

The `/nano-courses/` page is a **Next.js** SPA (App Router, fully
client-rendered — `BAILOUT_TO_CLIENT_SIDE_RENDERING`) that consumes
webservices from a **Moodle** backend on the same domain via
`POST /lib/ajax/service.php`. The relevant method names came from static
analysis of the JS chunks (`app/nano-courses/page-*.js`, `6426-*.js`).

```
Student ──► Next.js SPA (/nano-courses/*)
             │  POST /lib/ajax/service.php?sesskey=…   (JSON: [{index,methodname,args}])
             ▼
        Moodle (on.fiap.com.br)
             ├─ plugin local_nanocourses  (catalog, enrollment, chapters)
             ├─ plugin local_salavirtual  (video list per chapter)
             ├─ plugin local_fiapws       (progress writer)  ← critical spot
             └─ real player: same-origin iframe
                /local/streaming/embed.php?video_url=https://vimeo.com/<id>
```

## 2. Full automation chain

Every step below is plain HTTP; none requires JavaScript, a browser or a video.

### 2.1 Authentication

```
GET  /index.php                                   → anonymous session born (MoodleSession)
POST /index.php                                   → 303 Location: /local/home/
     body: username=<RM>&password=<password>&v=plataforma
```

The `MoodleSession` cookie (HttpOnly, Secure, SameSite=None) authenticates
everything that follows. Observations: **no captcha, no 2FA, no challenge**
in the standard login.

### 2.2 Sesskey (CSRF token)

```
GET /local/home/index.php  →  HTML contains "sesskey":"<value>"
```

The `sesskey` rides along as a query string. It protects against CSRF from
another site — not against a client operating its own session.

### 2.3 Catalog and account state

```
local_nanocourses_get_nanocourses_list {}
→ 103 nanos with id, qtd_capitulos, inscrito, visualizacao, url_subscribe…
local_nanocourses_get_credits_nanocourses {}
→ program, accumulated credits
```

### 2.4 Enrollment (the start of the "0")

```
GET /local/nanocourses/inscricao.php?sesskey=…&action=subscribe&id=<nano>
```

### 2.5 Course structure

```
local_nanocourses_get_conteudos {course_id}
→ chapters: [{ cmid, conteudosvideocm, visualizacao_html/video/audio/pdf, visualizacao }]
local_salavirtual_get_conteudo_video {cm: conteudosvideocm}
→ { contentname, videos: [{ id, duration_seconds, percent, lastsecond,
    link: <signed Vimeo MP4 URL>, … }] }
```

Exposure note: the response ships **signed progressive Vimeo MP4 URLs**
(`player.vimeo.com/progressive_redirect/...&signature=…`) — any
authenticated student can download the raw content without a player.

### 2.6 The critical spot — progress writing

The player front-end (chunk `6426`) sends, on `seeked`, every 15 s of
playback and on `pause`:

```js
local_fiapws_set_visualizacao {
  json: "[
    {courseModule, id, lastSecond, timeElapsed, mode:'time_spent', type:'video'},
    {courseModule, id, lastSecond, timeElapsed, mode:'view',      type:'video'}]"
}
```

- `lastSecond` = current position of the `<video>` inside the same-origin
  iframe;
- `timeElapsed` = accumulated on-screen seconds.

The server stores it and computes the per-video `percent` from the received
`lastSecond`. **No plausibility validation** (wall-clock time, actual
streaming, monotonicity) was observed.

### 2.7 The single-shot kill

For each pending video, one POST claiming the end:

```json
[{ "courseModule": <chapter cm>, "id": <video.id>,
   "lastSecond": <duration_seconds>, "timeElapsed": <duration_seconds + 1>,
   "mode": "time_spent", "type": "video" },
 { … same with "mode": "view" }]
```

Response: `{"error":false,"data":1}` → immediate `percent: 100`.

## 3. Executed evidence

| # | Test | Result |
|---|---|---|
| 1 | 1 POST for video 99400 (Big Data ch. 1) with `lastSecond=555` | `percent: 100` without playback |
| 2 | 3 POSTs (remaining ch. 1 videos) | chapter 1 `visualizacao: 100` (HTML 23%, audio 0% didn't matter) |
| 3 | Full PoC Big Data 15350 (already enrolled) | `[100,0,0,0,0,0] → 6/6` in 6.4 s incl. login |
| 4 | Full PoC Future-Proof 15385 (untouched) | API enrollment + `[0,0,0,0] → 4/4` (22 videos) in 8.5 s |
| 5 | Post-100% platform state | list shows `vis:100`; `can_realizar_prova` became `true`; credits still 0 (exam is the final gate) |

Chapter completion = 100% once **videos** reach 100 (HTML/audio/PDF were
not needed in the test). The unlocked certification exam is the relevant
side effect: the next gate in the credits flow becomes exposed to whoever
automates the exam — out of scope for that round.

## 4. Existing vs. missing controls

Present (and why they did not hold):

- `sesskey` (Moodle CSRF) — the attacker operates their own session;
- mandatory-nano gate (`norequiredcourse` error in `get_course_details`) —
  server-side, but the test account had already completed it; bypass not
  tested;
- `percent` requires `lastSecond ≥ duration_seconds` — trivially satisfied
  since both come from the same API response.

Missing: server-side time validation, perceptible rate limiting on
`service.php` (~40 rapid calls without blocking), captcha, 2FA,
front-end telemetry/fingerprinting (no real analytics references in the
chunks; the "gTag" hits were `Symbol.toStringTag`).

## 5. Honest limitations and next steps

- Not tested: mandatory-nano gate bypass for a fresh account, HTML/audio/PDF
  content as an alternative gate on video-less nanos, behavior against
  corporate/B2B accounts (`isB2b`).
- The PoC marks videos only; nanos whose 100% depends on other content types
  may need the matching `type` values (`html`, `audio`, `pdf`) — same API,
  same presumed weakness, not validated.
- Captcha/rate limiting may exist on another flow (e.g., repeated wrong
  passwords); only the happy authenticated path was tested.
- The pure-HTTP exam replica (`scripts/rred-quiz.js`) saves answers
  (sequencecheck increments) but scored 0.00 twice, while the recorded
  real-browser POST is **byte-for-byte identical** to what the replica sent.
  The divergence cause was not identified (see §6.4). From a risk
  perspective it is irrelevant: the browser variant is trivial and proven.

## 6. Phase 2 — Certification exam (`/mod/quiz/*`)

Question: is the exam that unlocks certification also automatable?
**Answer: yes — grade 100.00/100.00, certificate and credits issued without
studying anything.**

### 6.1 Quiz rules and flow (FIAP skin over Moodle)

- `GET /mod/quiz/view.php?id=<cmid>`: rules (e.g., 20 questions, one per
  page, 1h40–2h30 limit, **2 attempts**) + "Answer now" button + custom
  modal with `checkbox_iniciar` ("I'm ready").
- `POST /mod/quiz/startattempt.php` (cmid+sesskey, then + preflight
  `checkbox_iniciar=1&_qf__mod_quiz_preflight_check_form=1`) → 303 to
  `attempt.php?attempt=<id>`.
- `GET /mod/quiz/attempt.php?attempt=<id>&page=<n>`: one question per page;
  single-choice = radios `q<qid>:<slot>_answer` with a.–e. labels;
  multi-choice = checkboxes `q<qid>:<slot>_choice<N>` **injected by JS**
  (only 0-valued hiddens exist in the raw HTML).
- `POST /mod/quiz/processattempt.php`: form hiddens (`sequencecheck`,
  `attempt`, `thispage`, `nextpage`, `timeup`, `sesskey`, `scrollpos`,
  `slots`, `is_single_multichoice`) + answer + `next` button.
- Last page → `summary.php` → `POST processattempt.php` with
  `finishattempt=1&slots=&cmid=<cmid>&checkbox_finalizar=1` (skin-custom
  parameter; without it: "required parameter checkbox_finalizar missing").
- `GET /mod/quiz/review.php`: final grade in `data-finalgrade`; the skin
  **exposes no answer key or per-question review** (answer harvesting via
  review: impossible in this render).
- Post-100% gate: `local_quiz_get_status_prova_certificacao`
  (`status: <cmid>` = unlocked). After a **zeroed attempt**: cooldown —
  "new opportunity from 10/20/2026" (`status: -5`), the only pacing control
  observed in the whole flow.

### 6.2 Executed automation (proven)

Run with a real browser (controlled Chromium — Puppeteer/Playwright
equivalent) + DeepSeek (`deepseek-chat`, temperature 0) picking each answer:

1. standard login form;
2. "I'm ready" modal checked and submitted;
3. per page: extract `.qtext` + labels; JSON prompt to the LLM; click the
   chosen label; click "Next question";
4. summary → `checkbox_finalizar` → "Submit answers".

Result on the "Autonomous Agents (Agentic AI)" nano (15948, quiz 584482,
20 questions):

| Metric | Value |
|---|---|
| Final grade | **100.00 / 100.00** (`data-finalgrade`) |
| Correct | 20/20 (DeepSeek, first attempt) |
| Total browser-run duration | ~10 min (with safety waits; ~2 min achievable) |
| Certificate | **issued** |
| Credits | **6 credits** granted (before: 0) |

Evidence: `.recon/evidencia-nota-100.png` (grade screenshot, not committed).

Provider choice: DeepSeek as primary (lower cost per question, equivalent
quality — 20/20 in-domain); OpenAI tested on the same control question and
kept as fallback in the script.

### 6.3 Full attacked chain (risk view)

```
login (HTTP) → enrollment (HTTP) → 0→100% progress (HTTP, ~9 s)
            → exam with LLM (browser, 20/20) → CERTIFICATE + CREDITS
```

Total cost per nano: cents of API (20 DeepSeek prompts) + ~3 min of
machine time. No content was actually consumed at any step.

### 6.4 Engineering note (HTTP replica vs. browser)

A `submit` hook installed on the page recorded the browser's exact POST:

```json
{"attempt":"2559107","is_single_multichoice":"1","nextpage":"1",
 "q2592672:1_:sequencecheck":"1","q2592672:1_answer":"1","scrollpos":"",
 "sesskey":"…","slots":"1","thispage":"0","timeup":"0"}
```

which is identical (same fields and values) to what `scripts/rred-quiz.js`
was sending when it scored 0.00. The divergence was not explained —
candidates: some session/flow state sensitive to third-party cookies, or a
server-side validation that differentiates submissions outside the
browser's navigation sequence. Recorded as an engineering pending item; it
does not change the risk conclusion (§6.2).

## 7. Phase 3 — standalone solver and the credits goal

The phase-2 flow was consolidated into `scripts/rred-exam.mjs`
(puppeteer-core + system headless Edge, DeepSeek primary), runnable as a
single command with no interaction:

| Run | Nano | Progress (HTTP) | Exam (solver) | Grade | Credits |
|---|---|---|---|---|---|
| 1 | Agentic AI (15948, quiz 584482) | 100% in ~9 s | 20 questions | 100.00 | 6 |
| 2 | After Effects & Premiere (15347, quiz 568460) | 100% in 11 s (49 videos) | 29 questions in **109.6 s** incl. login | 90.00 | 15 |

**Test account total at the end: 21 credits** (goal: 20) and 2
certificates. 90.00 passed (cut-off ≤ 90). Robustness added to the solver
after testing: open-attempt resume ("Continue"), adaptive question wait,
failure-page diagnostics and the skin-custom `checkbox_finalizar` finish.

## 8. Phase 4 — autonomous 0→N credits pipeline (`rred-auto.mjs`)

An orchestrator that closes the loop with zero interaction: best-nano
selection (credits DESC, chapters ASC, exam-bearing), HTTP enrollment and
0→100%, exam-gate wait, Puppeteer solver and credits check in a loop until
the target.

### 8.1 Finding: the exam gate reads an async aggregator

Right after 0→100%, `local_quiz_get_status_prova_certificacao` still
reports `visualizacao: 0` ("completed 0%") for a variable interval (seconds
to minutes), while `get_conteudos` already shows 100% on every chapter. In
the first burst run (9 nanos in a row, queried ~0.3 s after marking) ALL
reported 0% and the pipeline skipped them; minutes later several had
propagated to "exam available". It is not an intentional security control
(it rejects nothing — it only delays the read), but it works incidentally
as a speed bump: the orchestrator needs polling (implemented: 15 s × up to
16 attempts).

### 8.2 Validation run

```
node scripts/rred-auto.mjs --target 30
[+3.6s]   initial credits: 21
[+4.8s]   chosen nano: Cybersecurity Hacker Skills (18 credits, already 100%)
[+109.1s] exam: grade 95.00 (20 questions, Puppeteer+DeepSeek)
[+109.3s] credits now: 39   ← TARGET HIT (30) in 109.3 s
```

Every credit-generating transition (enrollment, 0→100%, exam, approval)
happened autonomously in this session; from a clean account, 0→20 credits
lands at ~2–5 min, bounded only by gate propagation and solver time
(~2 min/exam).
