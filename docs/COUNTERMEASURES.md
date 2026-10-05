# Countermeasures — Nano Courses (blue-team side)

Companion to [`TECHNICAL_ANALYSIS.md`](TECHNICAL_ANALYSIS.md). The root
cause is a single one: **the server believes any client-declared timeline**.
The measures below attack that root and add detection over the data stock
that already exists.

## 1. Prevention (corrective, by priority)

### P0 — Server-side time validation in `set_visualizacao`

Store per (user, video) the timestamp of the last accepted ping and reject
physically impossible advances:

```
delta_lastSecond ≤ (now - last_ping) × max_speed + tolerance
```

- `max_speed` = 2× (accepts 2× playback, blocks "10 min of video in 1 s");
- `timeElapsed` must be ≤ wall-clock time since the previous ping — never
  incremented by client confession;
- progress is inherently **monotonic and non-receding**; a `lastSecond`
  smaller than the stored one must not reduce `percent`.

This alone kills the current PoC: the 22 videos of the test nano were marked
in ~5 s of wall time against ~2 h of declared content.

### P1 — Bind progress to actual media delivery

The player is already a same-origin iframe (`/local/streaming/embed.php`).
That page knows the session, the video and the real delivery start time.
Options:

- `embed.php` issues an ephemeral token (nonce per session+video) that
  `set_visualizacao` then requires; without opening the player, no progress;
- compare the interval between "first byte delivered to the player" and the
  declared `lastSecond` — the same P0 wall-clock accounting, now with proof
  of delivery.

### P2 — Rate limiting and burst caps on `/lib/ajax/service.php`

Per-user + per-method limit: the player's natural behavior is ~4 pings/min
(15 s per video). Any sequence of dozens of `set_visualizacao` within
seconds is a blockable anomaly on the spot.

### P3 — Login

No captcha and no 2FA in the tested flow. Full TOTP for student accounts is
debatable, but invisible captcha + per-IP/RM limits on password failures is
the minimum against credential stuffing (login is also step one of any bot).

### P4 — Content protection (secondary, same root)

`get_conteudo_video` ships signed Vimeo MP4 download-ready URLs. If the
content itself is the asset, shorten those URLs' TTL and bind them to the
player session (P1) to curb leaks at scale.

## 2. Detection (with what exists in the logs today)

### 2.1 Exact signature of the `rred.js` PoC

Burst of `POST /lib/ajax/service.php` with a body containing
`local_fiapws_set_visualizacao` where, **for the same user**:

1. volume: ≥ 10 calls in < 60 s (the legitimate player stays around 4/min);
2. `lastSecond == duration_seconds` on every video (exact end, always);
3. `timeElapsed == lastSecond + 1` in the submitted structure (the script's
   fingerprint; a human pauses/resumes and produces scattered values);
4. **absence** of `GET /local/streaming/embed.php` and of CDN (Vimeo)
   traffic while progress advances — the PoC never opens the player;
5. an entire course going 0→100% in wall time shorter than the sum of
   durations.

Any two of the above combined are enough for a high-confidence alert.

### 2.2 Retroactive audit queries (detect the stock)

```sql
-- declared progress vs wall time between first and last ping
SELECT cm, video_id, SUM(time_elapsed), MAX(perc),
       TIMESTAMPDIFF(SECOND, MIN(created), MAX(created)) AS wall
FROM local_fiapws_visualizacao
GROUP BY user_id, course, cm
HAVING SUM(time_elapsed) > TIMESTAMPDIFF(SECOND, MIN(created), MAX(created)) * 1.5;
-- courses completed faster than the sum of their durations
```

(adjust names to the real schema; the idea is comparing declared time ×
wall time per user.)

### 2.3 Tracking metrics

- distribution of 0→100% wall time per nano (tail below content duration =
  fraud);
- ratio of `set_visualizacao` pings / `embed.php` opens per session;
- completion rate per cohort over time (spikes after scripts circulate
  indicate sharing).

## 3. Phase 2 — Certification exam (`/mod/quiz/*`)

The exam was automated with a real browser + LLM: **grade 100/100,
certificate and credits issued** (TECHNICAL_ANALYSIS §6). The underlying
problem is different from progress: there was no protocol fraud to exploit —
the AI simply answered correctly. Viable measures:

### LLM-resistant assessment (reduces viability, does not eliminate)

1. **Dynamic, private question bank**: per-attempt random draws (already
   happens — shuffled slots) with a large rotating pool make harvesting
   hard — but an LLM answers unseen questions instantly; pool size alone
   does not solve it.
2. **Questions LLMs get wrong by construction**: intentional ambiguity,
   "pick the INCORRECT one", double negatives, semantically close options,
   and above all cases that depend on **course-internal material** (videos
   and internal scripts not public) — the model has not seen the specific
   content and fails without it. Today's questions are conceptual and
   answerable from general knowledge.
3. **Essay/code format with manual or test-based grading**: `essay` and
   programming questions graded by execution are expensive to automate with
   consistent quality.

### Automation signals (detection)

- **Interaction telemetry**: time per question, mouse/scroll movement, tab
  focus. A run with a constant ~5–10 s per question and zero mouse input is
  a clear signature (`page.evaluate`-driven browsers emit no real input
  events; synthetic clicks have detectable patterns).
- **Supernatural cadence**: 20 questions + impossible reading time relative
  to the observed pace; correlate per-question time × prompt length.
- **Uniform response pattern**: ~zero latency variance across questions of
  different difficulties.

### Flow controls (existing, to strengthen)

- The **retake cooldown** after a zeroed grade (until 10/20/2026) is the
  only pacing control today; extend it to: minimum time between the nano's
  100% and the exam start (currently zero — the exam ran seconds after the
  forged 100%), and a minimum exam duration before submission (a top grade
  in <2 min against 2h30 of content is an anomaly).
- The **exam gate reads an async aggregator** (visualizacao takes seconds to
  minutes to propagate after marking — analysis phase 4). It delayed the
  pipeline by minutes, nothing more; if intentional, make it an explicit
  per-account+nano rate limit (e.g., progress only counts toward
  certification if reported over ≥ X% of the course hours).
- **Bind the exam to real consumption**: require plausible progress
  evidence (section 1 P0/P1) before releasing the attempt — today the gate
  trusts the same forgeable `visualizacao`.

## 4. Note on "fixing it on the client"

Any obstacle placed in the Next.js front-end (obfuscated calls,
fingerprinting, tab-visibility checks) **does not solve this**: the attacker
speaks HTTP directly to Moodle, as the PoC proves. The control must live in
the service that writes progress and in the logs that audit it.
Obfuscation only raises the reverse-engineering cost of the chunks — which,
as demonstrated, was minutes of simple static analysis.
