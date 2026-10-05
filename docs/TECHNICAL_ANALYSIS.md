# Technical analysis

Assessment date: October 5, 2026. The FIAP security team provided the test
account. The scope covered `https://on.fiap.com.br/nano-courses/*` and,
from phase 2, `https://on.fiap.com.br/mod/quiz/*`.

## 1. Platform architecture

The `/nano-courses/` page is a Next.js application using the App Router.
The HTML contains `BAILOUT_TO_CLIENT_SIDE_RENDERING`, and the page renders
on the client. It calls a Moodle backend on the same domain through
`POST /lib/ajax/service.php`. We identified the methods by reading the
JavaScript chunks `app/nano-courses/page-*.js` and `6426-*.js`.

```text
Student → Next.js app (/nano-courses/*)
           │ POST /lib/ajax/service.php?sesskey=…
           │ JSON: [{index, methodname, args}]
           ▼
        Moodle (on.fiap.com.br)
           ├─ local_nanocourses: catalog, enrollment and chapters
           ├─ local_salavirtual: chapter videos
           ├─ local_fiapws: progress updates
           └─ same-origin video player iframe:
              /local/streaming/embed.php?video_url=https://vimeo.com/<id>
```

## 2. Course progress over HTTP

The enrollment and progress steps below use HTTP requests. They do not
require a browser, JavaScript execution or video playback.

### 2.1 Authentication

```text
GET  /index.php  → creates an anonymous MoodleSession
POST /index.php  → 303 Location: /local/home/
     body: username=<RM>&password=<password>&v=plataforma
```

The `MoodleSession` cookie authenticates later requests. It has the
HttpOnly, Secure and SameSite=None attributes. The tested login flow
did not present a captcha, 2FA prompt or other challenge.

### 2.2 CSRF token

```text
GET /local/home/index.php → HTML contains "sesskey":"<value>"
```

The AJAX requests include `sesskey` in the query string. This protects
against requests from another site. A script logged into its own account
can read and use the token.

### 2.3 Catalog and account state

```text
local_nanocourses_get_nanocourses_list {}
→ 103 courses with id, qtd_capitulos, inscrito, visualizacao, url_subscribe…
local_nanocourses_get_credits_nanocourses {}
→ program and accumulated credits
```

### 2.4 Enrollment

```text
GET /local/nanocourses/inscricao.php?sesskey=…&action=subscribe&id=<nano>
```

### 2.5 Course structure

```text
local_nanocourses_get_conteudos {course_id}
→ chapters: [{ cmid, conteudosvideocm, visualizacao_html/video/audio/pdf, visualizacao }]
local_salavirtual_get_conteudo_video {cm: conteudosvideocm}
→ { contentname, videos: [{ id, duration_seconds, percent, lastsecond,
    link: <signed Vimeo MP4 URL>, … }] }
```

The video response includes signed Vimeo MP4 URLs in the form
`player.vimeo.com/progressive_redirect/...&signature=…`. An authenticated
student receives these URLs and can request the media directly.

### 2.6 Progress updates

The player code in chunk `6426` sends progress on `seeked`, every 15 seconds
of playback and on `pause`:

```js
local_fiapws_set_visualizacao {
  json: "[
    {courseModule, id, lastSecond, timeElapsed, mode:'time_spent', type:'video'},
    {courseModule, id, lastSecond, timeElapsed, mode:'view',      type:'video'}]"
}
```

`lastSecond` is the video's current position inside the iframe.
`timeElapsed` is the accumulated time on screen. The server uses the
reported `lastSecond` to calculate `percent`. In our tests, it accepted
progress without enough elapsed time for playback. We did not observe
checks for media delivery or progression over time.

### 2.7 Marking a video complete

For each pending video, the script sent one request with `lastSecond`
equal to the full duration:

```text
[{ "courseModule": <chapter cm>, "id": <video.id>,
   "lastSecond": <duration_seconds>, "timeElapsed": <duration_seconds + 1>,
   "mode": "time_spent", "type": "video" },
 { … same fields with "mode": "view" }]
```

The response was `{"error":false,"data":1}`, and the video's `percent`
then read 100. No video had been played.

## 3. Test results

| Test | Result |
|---|---|
| One POST for video 99400, Big Data chapter 1, with `lastSecond=555` | `percent: 100` without playback |
| Three POSTs for the remaining chapter 1 videos | Chapter `visualizacao: 100`, despite HTML at 23% and audio at 0% |
| Big Data (15350), already enrolled | `[100,0,0,0,0,0]` to all 6 chapters complete in 6.4 s, including login |
| Future-Proof (15385), not enrolled | Enrolled and completed all 4 chapters (22 videos) in 8.5 s |
| Account state after completion | Course list showed `vis:100`; `can_realizar_prova` became `true`; credits remained at 0 until the exam |

In these courses, completing the videos was enough to complete each
chapter. HTML, audio and PDF progress did not need to reach 100%. Course
completion made the certification exam available; passing the exam was
still required for credits. The exam was tested in the next phase.

## 4. Controls observed

The platform required a session and a Moodle `sesskey`. Both were available
to the script after login. A mandatory course requirement also existed:
`get_course_details` can return `norequiredcourse`. The test account had
already met that requirement, so we did not test a bypass.

Video completion required `lastSecond ≥ duration_seconds`. The API exposed
the duration, allowing the script to supply that value.

About 40 rapid calls to `service.php` produced no rate-limit response. We
saw no captcha or 2FA challenge in the tested flow, and found no analytics
references in the inspected chunks; matches for "gTag" were references to
`Symbol.toStringTag`. These observations do not rule out controls on other
routes or under different conditions.

## 5. Limitations

- We did not test the mandatory course requirement on a fresh account,
  courses without videos, or corporate/B2B accounts (`isB2b`).
- The progress script only marks videos. Other content types may have
  different completion requirements; `html`, `audio` and `pdf` updates
  were not validated.
- Login tests used valid credentials. Checks triggered by repeated failed
  logins were not tested.
- The HTTP exam script saved answers, as indicated by `sequencecheck`, but
  scored 0.00 in two attempts. The cause is unresolved. The browser version
  passed the exam; section 6.4 records the difference.

## 6. Phase 2: certification exams

We tested whether the exam could also be completed by a script. On the
Agentic AI course, the browser run scored 100/100 and the platform issued
a certificate and 6 credits.

### 6.1 Exam flow

The FIAP interface uses Moodle's quiz routes:

- `GET /mod/quiz/view.php?id=<cmid>` displays the rules and an "Answer now"
  button. Tested exams had one question per page, time limits of 1h40–2h30
  and two attempts. A confirmation modal uses `checkbox_iniciar`.
- `POST /mod/quiz/startattempt.php` accepts `cmid` and `sesskey`, followed
  by `checkbox_iniciar=1&_qf__mod_quiz_preflight_check_form=1` for the
  preflight check. It redirects to `attempt.php?attempt=<id>`.
- `GET /mod/quiz/attempt.php?attempt=<id>&page=<n>` displays a question.
  Single-answer fields are radios named `q<qid>:<slot>_answer`, with a.–e.
  labels. Multiple-answer fields are checkboxes named
  `q<qid>:<slot>_choice<N>`, added by JavaScript; the raw HTML contains
  only their hidden fields with value 0.
- `POST /mod/quiz/processattempt.php` submits the answer, the `next` button
  and hidden fields: `sequencecheck`, `attempt`, `thispage`, `nextpage`,
  `timeup`, `sesskey`, `scrollpos`, `slots` and `is_single_multichoice`.
- The last page leads to `summary.php`. Final submission requires
  `finishattempt=1&slots=&cmid=<cmid>&checkbox_finalizar=1`. Without the
  FIAP-specific checkbox field, the server reports
  "required parameter checkbox_finalizar missing".
- `GET /mod/quiz/review.php` reports the grade in `data-finalgrade`.
  The page we inspected did not show an answer key or per-question review.

`local_quiz_get_status_prova_certificacao` returns a positive `status`
containing the exam's `cmid` when an attempt is available. After an attempt
scored zero, it returned `status: -5` with a new opportunity date of
October 20, 2026.

### 6.2 Browser test

A controlled Chromium browser logged in, confirmed the start modal and
read `.qtext` and the option labels on each page. DeepSeek
(`deepseek-chat`, temperature 0) returned an answer in JSON. The script
selected the answer, advanced to the next question and confirmed the
final submission through `checkbox_finalizar`.

Results for Autonomous Agents (Agentic AI), course 15948, quiz 584482:

| Metric | Result |
|---|---|
| Grade | 100.00 / 100.00, read from `data-finalgrade` |
| Correct answers | 20/20 on the first browser attempt |
| Duration | About 10 minutes, including waits between steps |
| Certificate | Issued |
| Credits | 6, up from 0 |

The grade screenshot is stored at `.recon/evidencia-nota-100.png` and is
not committed. DeepSeek was used for this run. OpenAI was tested on the
same control question and is available as an alternative provider in the
scripts; that check does not establish equivalent performance across exams.

### 6.3 Combined flow

```text
Login → enrollment → progress updates → exam → certificate and credits
 HTTP      HTTP        HTTP (~9 s)      browser + LLM
```

The course progress and exam steps both completed without watching the
lessons. The test notes estimate a few cents of API usage for 20 DeepSeek
requests; this is not a fixed cost or a benchmark for other courses.

### 6.4 HTTP version and browser results

A `submit` hook recorded this browser POST:

```json
{"attempt":"2559107","is_single_multichoice":"1","nextpage":"1",
 "q2592672:1_:sequencecheck":"1","q2592672:1_answer":"1","scrollpos":"",
 "sesskey":"…","slots":"1","thispage":"0","timeup":"0"}
```

The recorded fields and values matched those submitted by
`scripts/rred-quiz.js`, but the HTTP runs scored zero. We did not identify
the cause. Session state, cookies or differences in the navigation
sequence are possible explanations, and remain unverified. Matching a
form body does not establish that the full requests and sessions match.

The browser results show that exam automation worked. The HTTP version
remains experimental.

## 7. Phase 3: standalone exam script

The browser flow was moved into `scripts/rred-exam.mjs`, using
`puppeteer-core`, the system's headless Edge and DeepSeek by default.

| Course | Progress over HTTP | Exam | Grade | Credits |
|---|---|---|---|---|
| Agentic AI (15948, quiz 584482) | 100% in about 9 s | 20 questions | 100.00 | 6 |
| After Effects & Premiere (15347, quiz 568460) | 100% in 11 s; 49 videos | 29 questions in 109.6 s, including login | 90.00 | 15 |

The account reached 21 credits and held two certificates, exceeding the
20-credit target. A grade of 90.00 passed; the exact passing threshold was
not established. The script also handles an open attempt through
"Continue", waits for questions to load, reports page diagnostics on
failure and includes `checkbox_finalizar` in the finish step.

## 8. Phase 4: course runner

`rred-auto.mjs` selects courses that offer credits and have no certificate
yet, ordered by credits descending and chapter count ascending. It enrolls
if needed, submits video progress, waits for the exam, calls the browser
script and checks the balance. It repeats until it reaches the target or
stops. Courses whose exams are unavailable are skipped.

### 8.1 Delay before the exam becomes available

Immediately after progress updates, `get_conteudos` showed every chapter
at 100%, while `local_quiz_get_status_prova_certificacao` still reported
`visualizacao: 0`. The discrepancy lasted seconds to minutes, consistent
with an asynchronous update. We did not inspect the server implementation.

In a run covering nine courses, checks about 0.3 seconds after marking
progress all returned 0%, so the runner skipped them. Several exams became
available minutes later. The runner now checks every 15 seconds, for up
to 16 additional checks. The observed delay postponed exam access but
did not reject the submitted progress.

### 8.2 Validation run

The recorded run used `node scripts/rred-auto.mjs --target 30`:

| Elapsed time | Event |
|---|---|
| 3.6 s | Initial balance: 21 credits |
| 4.8 s | Selected Cybersecurity Hacker Skills: 18 credits, already at 100% progress |
| 109.1 s | Exam scored 95.00 across 20 questions |
| 109.3 s | Balance reached 39 credits, exceeding the target of 30 |

Each step needed to award credits ran without manual intervention at least
once during the assessment. This run began with existing credits and
completed progress. The estimated 2–5 minutes to reach 20 credits from
zero depends on progress propagation and exam duration, and was not
measured as one complete run from a fresh account.
