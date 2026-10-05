# rred

Security assessment of FIAP ON Nano Courses, carried out with the FIAP
security team on October 5, 2026, using a test account they provided.

We tested whether scripts could mark courses as complete and pass the
certification exams without watching the lessons. Both worked in the
tested courses. This repository contains the scripts, test results and
proposed fixes.

## What we found

The platform accepts video progress reported by the client through
`local_fiapws_set_visualizacao`. Sending a video's full duration as
`lastSecond` was enough to mark it as watched. We did not observe a check
against the time that had actually passed.

| Course | Before the test | Result | Time, including login |
|---|---|---|---|
| Big Data (15350) | `[100,0,0,0,0,0]` | All 6 chapters at 100% | 6.4 s |
| Future-Proof (15385) | Not enrolled; `[0,0,0,0]` | Enrolled; all 4 chapters at 100% (22 videos) | 8.5 s |

Completing the videos unlocked the certification exam. A browser script
then read each question, asked DeepSeek for an answer and submitted it.
The first Agentic AI exam run scored 100/100, issued a certificate and
added 6 credits to the account. That run took about 10 minutes, including
waits between steps.

We later put the browser flow into `rred-exam.mjs` and added
`rred-auto.mjs` to select courses, enroll, submit progress, wait for the
exam to become available and check the credit balance after each exam.

| Run | Result |
|---|---|
| Agentic AI (15948) | Progress completed in about 9 s; exam scored 100/100; 6 credits |
| After Effects & Premiere (15347) | 49 videos marked in 11 s; 29-question exam scored 90/100 in 109.6 s, including login; 15 credits |
| `rred-auto.mjs --target 30` | Account went from 21 to 39 credits in 109.3 s after scoring 95/100 on Cybersecurity Hacker Skills, which was already at 100% progress |

Enrollment, progress updates, exams and credit awards each ran without
manual intervention during the assessment. No lessons were watched. The
last run started with 21 credits and a completed course, so it does not
measure the time needed to reach the target from a fresh account. The
estimated 2–5 minutes from 0 to 20+ credits depends on exam availability
and the time taken to answer questions; it was not measured in a single
run from a fresh account.

We saw no captcha, 2FA challenge or rate-limit response in the tested
flow. A failed exam did trigger a retake cooldown. Progress also took
seconds to minutes to appear in the exam availability check. See the
[technical analysis](docs/TECHNICAL_ANALYSIS.md) for the evidence and
limits of these findings, and the [proposed fixes](docs/COUNTERMEASURES.md).

## Files

- `cli.mjs`: interactive menu and command shortcuts.
- `scripts/rred.js`: enrollment and video progress updates over HTTP.
- `scripts/rred-exam.mjs`: browser script for certification exams, using
  Puppeteer, an installed Edge or Chrome, and DeepSeek or OpenAI.
- `scripts/rred-auto.mjs`: repeats course completion and exams until the
  account reaches a credit target or the run stops.
- `scripts/rred-quiz.js` and `scripts/quiz-parse.js`: experimental HTTP
  version of the exam flow. Answers appeared to save, but both test runs
  scored zero; see [section 6.4](docs/TECHNICAL_ANALYSIS.md#64-http-version-and-browser-results).
- `scripts/quiz-page-answer.mjs`: reads a saved question page, requests an
  answer and prints the form body for submission.

## Setup and use

Use Node.js 24 and install the dependency:

```bash
npm install
```

Puppeteer uses an installed Edge or Chrome; it does not download a browser.
The exam script checks standard Windows installation paths.

```bash
node cli.mjs                      # Open the menu
node cli.mjs status               # List courses and progress
node cli.mjs auto 20              # Run until the account has at least 20 credits

# Run each step separately:
node scripts/rred.js --course 15347
node scripts/rred-exam.mjs --cmid 568460

# Set limits when calling the course runner directly:
node scripts/rred-auto.mjs --target 30 --max-nanos 5
```

### Credentials

Copy `.env.example` to `.env` and fill in the portal credentials and an
API key:

```ini
RRED_RM=123456
RRED_PASSWORD="your-password"
DEEPSEEK_API_KEY="sk-..."
```

You can also set these as environment variables. Existing environment
variables take precedence over `.env`. The CLI asks for missing values
and offers to save them to `.env`; it asks for an API key when you choose
an exam or a credit-target run. `.env` is excluded from Git by default.

For OpenAI, set `OPENAI_API_KEY` and pass `--provider openai` to
`rred-exam.mjs`. Use `--headed` to show the browser during an exam.
The credit-target runner calls the exam script with
its default provider, DeepSeek.

To skip the banner animation, use `--no-banner` or set `RRED_NO_BANNER=1`.

## Scope

The assessment covered `https://on.fiap.com.br/nano-courses/*`,
`https://on.fiap.com.br/mod/quiz/*`, platform login and the AJAX services
used by those flows.

The security team provided the test account and funded the API keys.
No real student data was accessed. Credentials and raw session evidence
are kept outside version control.

We did not test third-party credentials, bypassing the mandatory course
requirement, other courses or plugins, or access to answers through the
exam review page. The test account had already met the mandatory course
requirement, and the review page did not display an answer key.
