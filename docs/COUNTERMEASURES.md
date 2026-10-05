# Proposed fixes and detection

The [technical analysis](TECHNICAL_ANALYSIS.md) records two findings:
the server accepted video progress without playback, and a browser script
using an LLM passed certification exams. The first needs a change to how
progress is recorded. The second needs a review of assessment design and
ways to detect automated attempts.

These are proposed controls. Their effectiveness has not been tested
against the scripts in this repository.

## 1. Progress validation, in priority order

### P0: validate elapsed time on the server

For each user and video, store the time of the last accepted progress
update. Compare the reported advance with the time that has passed:

```text
delta_lastSecond ≤ (now - last_ping) × max_speed + tolerance
```

A maximum speed of 2× would allow double-speed playback while rejecting
a claim of ten minutes watched in one second. Calculate elapsed time on
the server rather than trusting `timeElapsed`. Keep the highest accepted
progress when a student seeks backwards.

This check would reject the timing used in the Future-Proof test: the
script marked 22 videos in about five seconds, reporting roughly two
hours of content. Playback starts, seeks and tolerance values need to
be accounted for when implementing the check.

### P1: connect progress updates to a playback session

The player already uses a same-origin iframe at
`/local/streaming/embed.php`. Use that session to identify the user and
video, and establish when playback could have started.

One option is a short-lived token for each session and video, issued by
`embed.php` and required by `set_visualizacao`. Where delivery data is
available, compare its start time with the reported progress. A token or
a media request alone does not prove the student watched the lesson;
combine it with the elapsed-time check.

### P2: limit bursts of progress updates

Apply limits by user and method on `/lib/ajax/service.php`. The tested
player updates about every 15 seconds during playback, with additional
updates on pause and seek. Dozens of updates for different videos within
a few seconds should trigger a check. Allow for the paired `time_spent`
and `view` records when setting thresholds.

### P3: review login protections

The tested login did not present captcha or 2FA. Review limits on failed
logins by IP and RM, and consider captcha or additional authentication
where appropriate. Valid-credential tests do not show whether protections
against repeated failed logins already exist.

### P4: review media URL access

`get_conteudo_video` returns signed Vimeo MP4 URLs that can be requested
directly. Review their lifetime and whether access can be tied to the
player session. This addresses content distribution; progress validation
still needs the controls above.

## 2. Detection

### 2.1 Patterns produced by `rred.js`

Look for `POST /lib/ajax/service.php` requests containing
`local_fiapws_set_visualizacao`. For the same user, the script produces
several patterns:

1. At least ten calls within a minute, often covering multiple videos.
2. `lastSecond` exactly equal to `duration_seconds` for each video.
3. `timeElapsed` exactly equal to `lastSecond + 1`.
4. Progress advances without opening `/local/streaming/embed.php`. Media
   delivery records can provide another check where those logs are available.
5. A course reaches 100% in less time than playback would require, after
   accounting for supported playback speeds and prior progress.

Use combinations of these patterns to flag sessions for review. Tune
thresholds against normal player traffic before treating them as grounds
for blocking an account.

### 2.2 Review historical progress

Compare declared viewing time with elapsed time between progress records.
The original query sketch is below; table and column names need to be
adapted to the actual schema:

```sql
-- Compare declared progress with elapsed time between records.
SELECT cm, video_id, SUM(time_elapsed), MAX(perc),
       TIMESTAMPDIFF(SECOND, MIN(created), MAX(created)) AS wall
FROM local_fiapws_visualizacao
GROUP BY user_id, course, cm
HAVING SUM(time_elapsed) > TIMESTAMPDIFF(SECOND, MIN(created), MAX(created)) * 1.5;
```

This is a sketch, not a validated production query. Check whether
`time_elapsed` is incremental or cumulative before summing it, and align
the selected fields with the grouping used by the database. Compare
course completion times with video durations as a separate check.

### 2.3 Metrics to track

- Completion time by course, including unusually short runs.
- Progress updates compared with player opens in the same session.
- Completion rates by cohort over time, to spot changes that warrant review.

## 3. Certification exams

The browser test scored 100/100 and received a certificate and credits
([technical analysis, section 6](TECHNICAL_ANALYSIS.md#6-phase-2-certification-exams)).
The script used the normal exam flow and answered correctly, so validating
progress requests alone will not address exam automation.

### Assessment design

A larger, regularly updated private question bank can make answer
collection harder. It does not prevent an LLM from answering questions
it has never seen. The tested questions could be answered from general
technical knowledge.

Consider questions that require applying material from the course to a
specific case. Assess whether written explanations, practical work or
code evaluated by tests would provide better evidence of learning.
These formats can also be assisted by AI, and may require manual review.
Ambiguous wording and double negatives should not be treated as a
reliable defense.

### Signals to review

Question timing, scrolling, focus changes and input events may help
identify automated attempts. In particular, look for short completion
times and similar response times across questions with different lengths
or difficulty. Correlate those signals with course progress and exam
results. No single interaction pattern establishes that an attempt was
automated.

### Exam access and pacing

The test observed a retake cooldown after a zero score, with the next
opportunity on October 20, 2026. Review whether additional pacing checks
are useful, such as the interval between course completion and the exam
or unusually short exam durations. These checks should use observed
student behavior and exam requirements; a short attempt alone does not
prove misconduct.

The delay between chapter completion and exam availability also needs
review. It postponed the script's access, but the exam eventually opened
after accepting the same progress reports. Require server-validated
progress before releasing a certification attempt.

## 4. Where to enforce the controls

The progress script sends requests directly to Moodle. Changes to the
Next.js interface, such as obfuscation or tab-visibility checks, would
not stop those requests. Validate progress in the service that records
it, and retain enough information to review suspicious sessions.
