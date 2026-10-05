#!/usr/bin/env node
/**
 * rred — Nano Courses progress automation PoC (FIAP ON).
 *
 * Authorized scope: https://on.fiap.com.br/nano-courses/*
 * Purpose: purple-team exercise by the security team (proof of concept +
 * input for countermeasures). Do not use outside the scope.
 *
 * Flow: login → sesskey → nano list → (enroll if needed) → chapters →
 * videos → set_visualizacao claiming the end of each video → before/after
 * progress report with per-step timings.
 *
 * Usage:
 *   node scripts/rred.js --list
 *   node scripts/rred.js --course 15350
 *   node scripts/rred.js --course 15350 --dry-run
 *
 * Credentials (in precedence order): RRED_RM/RRED_PASSWORD environment
 * variables, or a KEY=VALUE .env file in the project root (gitignored).
 */

// pick up .env from the project root without overriding real env vars
try {
  const fs = require("node:fs");
  const path = require("node:path");
  const envPath = path.join(__dirname, "..", ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* no .env — fine */ }

const BASE = "https://on.fiap.com.br";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- util

const t0 = Date.now();
const step = (msg) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--course") out.courseId = Number(argv[++i]);
    else if (a === "--delay") out.delay = Number(argv[++i]) || 0;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// ---------------------------------------------------------- http/session

let cookie = ""; // the MoodleSession value (the only relevant cookie)

async function http(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      ...(cookie && { Cookie: `MoodleSession=${cookie}` }),
      ...headers,
    },
    body,
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /MoodleSession=([a-zA-Z0-9]+)/.exec(setCookie);
  if (m) cookie = m[1];
  return res;
}

async function login(rm, password) {
  // first GET so the anonymous session is born (origin cookies)
  await http("/index.php");
  const res = await http("/index.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: rm, password, v: "plataforma" }).toString(),
  });
  const location = res.headers.get("location") || "";
  if (res.status !== 303 || !location.includes("/local/home/")) {
    throw new Error(`login refused (HTTP ${res.status}, redirect ${location || "none"})`);
  }
  step(`login ok → session established (redirect ${location})`);
}

async function fetchSesskey() {
  const res = await http("/local/home/index.php");
  const html = await res.text();
  const m = /"sesskey":"([^"]+)"/.exec(html);
  if (!m) throw new Error("sesskey not found");
  step("sesskey obtained");
  return m[1];
}

/** Moodle AJAX webservice call (same format the Next.js front-end uses). */
async function ws(sesskey, calls) {
  const res = await http(`/lib/ajax/service.php?sesskey=${sesskey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ index: i, ...c }))),
  });
  const out = await res.json();
  for (const r of out) {
    if (r.error) throw new Error(`webservice ${r.exception || ""}: ${JSON.stringify(r.error)}`);
  }
  return out.map((r) => {
    let d = r.data;
    if (typeof d === "string") {
      try { d = JSON.parse(d); } catch { /* keep string */ }
    }
    return d;
  });
}

const call = (methodname, args) => ({ methodname, args });

// ------------------------------------------------------------ domain

async function listNanos(sesskey) {
  const [data] = await ws(sesskey, [call("local_nanocourses_get_nanocourses_list", {})]);
  return data;
}

/** Marks a video as 100% without playback: lastSecond = total duration. */
function markVideoCall(courseModule, video) {
  const payload = [
    { courseModule, id: video.id, lastSecond: video.duration_seconds, timeElapsed: video.duration_seconds + 1, mode: "time_spent", type: "video" },
    { courseModule, id: video.id, lastSecond: video.duration_seconds, timeElapsed: video.duration_seconds + 1, mode: "view", type: "video" },
  ];
  return call("local_fiapws_set_visualizacao", { json: JSON.stringify(payload) });
}

async function driveCourse(sesskey, courseId, { dryRun = false, delay = 0 } = {}) {
  // 1) initial state
  const [detailsBefore] = await ws(sesskey, [call("local_nanocourses_get_course_details", { course_id: courseId })]);
  step(`course: ${detailsBefore.nome} (workload ${detailsBefore.carga_horaria}h, credits ${detailsBefore.creditos})`);
  if (!detailsBefore.subscribed) {
    if (dryRun) throw new Error("not enrolled — dry-run will not enroll");
    step("enrolling via inscricao.php…");
    await http(detailsBefore.url_inscricao.replace(BASE, ""));
    // course context switch (what the "start" button does on the front-end)
    await http(`/troca-curso.php?id=${courseId}`);
  }

  // 2) chapters
  const [chapters] = await ws(sesskey, [call("local_nanocourses_get_conteudos", { course_id: courseId })]);
  step(`chapters: ${chapters.length} | initial progress: ${JSON.stringify(chapters.map((c) => c.visualizacao))}`);

  let marked = 0;
  for (const ch of chapters) {
    if (!ch.conteudosvideocm) { step(`  ${ch.nome}: no video (cm ${ch.cmid}) — skipping`); continue; }
    const [videoData] = await ws(sesskey, [call("local_salavirtual_get_conteudo_video", { cm: ch.conteudosvideocm })]);
    const pending = (videoData.videos || []).filter((v) => v.percent !== 100);
    step(`  ${ch.nome}: ${videoData.videos.length} videos, ${pending.length} pending`);
    if (dryRun || pending.length === 0) continue;
    const results = await ws(sesskey, pending.map((v) => markVideoCall(ch.conteudosvideocm, v)));
    marked += results.length;
    if (delay) await sleep(delay);
  }

  if (dryRun) { step("dry-run: nothing was sent to the server"); return; }

  // 3) final state
  const [chaptersAfter] = await ws(sesskey, [call("local_nanocourses_get_conteudos", { course_id: courseId })]);
  step(`final progress: ${JSON.stringify(chaptersAfter.map((c) => c.visualizacao))}`);
  const done = chaptersAfter.filter((c) => c.visualizacao === 100).length;
  step(`chapters at 100%: ${done}/${chaptersAfter.length} | videos marked: ${marked}`);
}

// ---------------------------------------------------------------- main

(async () => {
  const args = parseArgs(process.argv);

  const rm = process.env.RRED_RM;
  const password = process.env.RRED_PASSWORD;
  if (!rm || !password) {
    console.error("set RRED_RM and RRED_PASSWORD in the environment");
    process.exit(2);
  }

  step("authenticating…");
  await login(rm, password);
  const sesskey = await fetchSesskey();

  if (args.list || !args.courseId) {
    const data = await listNanos(sesskey);
    console.log(`\n${data.courses.length} nanos | hasRequiredNano: ${data.hasRequiredNano}`);
    for (const c of data.courses) {
      console.log(
        `${String(c.id).padEnd(6)} ${c.nome.slice(0, 45).padEnd(46)} ch:${String(c.qtd_capitulos).padStart(2)} ` +
        `enrolled:${c.inscrito} vis:${c.visualizacao}${c.obrigatorio ? " [MANDATORY]" : ""}`
      );
    }
    process.exit(0);
    return;
  }

  step(`target: nano ${args.courseId}`);
  await driveCourse(sesskey, args.courseId, { dryRun: args.dryRun, delay: args.delay });
  step("done");
  process.exit(0);
})().catch((e) => {
  console.error(`[!] ${e.message}`);
  process.exit(1);
});
