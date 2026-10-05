#!/usr/bin/env node
/**
 * rred-auto — autonomous Nano Courses credits pipeline.
 *
 * Authorized scope: https://on.fiap.com.br/nano-courses/* and
 * https://on.fiap.com.br/mod/quiz/* (purple-team, FIAP security team).
 *
 * One single command: while credits < target → pick the best nano (most
 * credits, fewest chapters, exam-bearing) → HTTP enroll + 0→100% → wait
 * for the exam gate → solve the exam with the Puppeteer solver
 * (rred-exam.mjs) → check credits → next. Detects cooldowns and moves on
 * to another candidate.
 *
 * Usage:
 *   RRED_RM=… RRED_PASSWORD=… DEEPSEEK_API_KEY=… \
 *   node scripts/rred-auto.mjs [--target 20] [--max-nanos 5]
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnvFile } from "./lib-env.mjs";

loadEnvFile(); // picks up .env from the project root, if present

const BASE = "https://on.fiap.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HERE = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]] : []))
);
const TARGET = Number(args.target) || 20;
let maxNanos = Number(args["max-nanos"]) || 5;

const RM = process.env.RRED_RM, PW = process.env.RRED_PASSWORD;
if (!RM || !PW) { console.error("set RRED_RM and RRED_PASSWORD"); process.exit(2); }

const t0 = Date.now();
const step = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------------------------------------------------------------- http

let cookies = {};

async function http(path, { method = "GET", body, headers = {} } = {}) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    method, redirect: "manual",
    headers: { "User-Agent": UA, ...(jar && { Cookie: jar }), ...headers }, body,
  });
  for (const c of typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []) {
    const m = /^\s*([a-zA-Z0-9_]+)=([^;]*)/.exec(c);
    if (m) cookies[m[1]] = m[2];
  }
  return res;
}

async function login() {
  await http("/index.php");
  const res = await http("/index.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: RM, password: PW, v: "plataforma" }).toString(),
  });
  const loc = res.headers.get("location") || "";
  if (res.status !== 303 || !loc.includes("/local/home/")) throw new Error("login refused");
}

async function getSesskey() {
  const html = await (await http("/local/home/index.php")).text();
  const m = /"sesskey":"([^"]+)"/.exec(html);
  if (!m) throw new Error("sesskey not found");
  return m[1];
}

async function ws(sesskey, calls) {
  const res = await http(`/lib/ajax/service.php?sesskey=${sesskey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ index: i, ...c }))),
  });
  const out = await res.json();
  for (const r of out) if (r.error) throw new Error(`webservice: ${JSON.stringify(r.error)}`);
  return out.map((r) => {
    let d = r.data;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch {} }
    return d;
  });
}

const call = (methodname, args) => ({ methodname, args });

// ------------------------------------------------- domain (phase 1, HTTP)

async function getCredits(sesskey) {
  const [c] = await ws(sesskey, [call("local_nanocourses_get_credits_nanocourses", {})]);
  return Array.isArray(c) ? c[0]?.creditos ?? 0 : 0;
}

async function listNanos(sesskey) {
  const [data] = await ws(sesskey, [call("local_nanocourses_get_nanocourses_list", {})]);
  return data;
}

async function enroll(sesskey, course) {
  await http(course.url_subscribe.replace(BASE, ""));
  await http(`/troca-curso.php?id=${course.id}`);
}

async function completeCourse(sesskey, courseId) {
  const [chapters] = await ws(sesskey, [call("local_nanocourses_get_conteudos", { course_id: courseId })]);
  let marked = 0;
  for (const ch of chapters) {
    if (!ch.conteudosvideocm) continue;
    const [vd] = await ws(sesskey, [call("local_salavirtual_get_conteudo_video", { cm: ch.conteudosvideocm })]);
    const pending = (vd.videos || []).filter((v) => v.percent !== 100);
    if (!pending.length) continue;
    await ws(sesskey, pending.map((v) =>
      call("local_fiapws_set_visualizacao", {
        json: JSON.stringify([
          { courseModule: ch.conteudosvideocm, id: v.id, lastSecond: v.duration_seconds, timeElapsed: v.duration_seconds + 1, mode: "time_spent", type: "video" },
          { courseModule: ch.conteudosvideocm, id: v.id, lastSecond: v.duration_seconds, timeElapsed: v.duration_seconds + 1, mode: "view", type: "video" },
        ]),
      })
    ));
    marked += pending.length;
  }
  return { chapters: chapters.length, marked };
}

async function quizStatus(sesskey, courseId) {
  const [st] = await ws(sesskey, [call("local_quiz_get_status_prova_certificacao", { course_id: courseId })]);
  return st;
}

/**
 * The exam gate reads an async aggregator: right after 0→100% it may still
 * report 0%. Poll until status becomes a cmid (>0) or the window expires.
 */
async function waitQuizAvailable(sesskey, courseId, { tries = 16, everyMs = 15000 } = {}) {
  let st = await quizStatus(sesskey, courseId);
  for (let i = 0; i < tries && !(typeof st.status === "number" && st.status > 0) && st.status !== -5; i++) {
    await new Promise((r) => setTimeout(r, everyMs));
    st = await quizStatus(sesskey, courseId);
  }
  return st;
}

function solveExam(cmid) {
  const r = spawnSync(process.execPath, [join(HERE, "rred-exam.mjs"), "--cmid", String(cmid)], {
    encoding: "utf8", timeout: 420000,
  });
  const grade = /FINAL GRADE: ([\d,]+)/.exec(r.stdout || "")?.[1] || null;
  return { grade, ok: r.status === 0 && !!grade, stdout: (r.stdout || "") + (r.stderr || "") };
}

// ---------------------------------------------------------------- main

(async () => {
  step(`target: ${TARGET} credits`);
  await login();
  const sesskey = await getSesskey();
  step("login ok");

  let credits = await getCredits(sesskey);
  step(`initial credits: ${credits}`);
  if (credits >= TARGET) { step("target already met — nothing to do"); process.exit(0); }

  const data = await listNanos(sesskey);
  // candidates: exam-bearing (has_certificado=false), credits > 0
  const blacklist = new Set();
  const candidates = data.courses
    .filter((c) => !c.has_certificado && c.creditos > 0)
    .sort((a, b) => b.creditos - a.creditos || a.qtd_capitulos - b.qtd_capitulos);

  for (const nano of candidates) {
    if (credits >= TARGET) break;
    if (blacklist.has(nano.id)) continue;
    step(`chosen nano: ${nano.nome} (id ${nano.id}, ${nano.creditos} credits, ${nano.qtd_capitulos} chapters)`);

    if (!nano.inscrito) { await enroll(sesskey, nano); step("enrolled"); }
    if (nano.visualizacao !== 100) {
      const { chapters, marked } = await completeCourse(sesskey, nano.id);
      step(`0→100% over HTTP: ${chapters} chapters, ${marked} videos marked`);
    } else {
      step("already at 100% — straight to the exam gate");
    }

    const st = await waitQuizAvailable(sesskey, nano.id);
    const cmid = typeof st.status === "number" && st.status > 0 ? st.status : null;
    if (!cmid) {
      step(`exam unavailable (status ${st.status}: ${(st.text || "").slice(0, 80)}) — next nano`);
      blacklist.add(nano.id);
      continue;
    }

    step(`solving exam cmid ${cmid} (Puppeteer + LLM)…`);
    const exam = solveExam(cmid);
    const log = exam.stdout.split("\n").filter((l) => /^\[|FINAL/.test(l)).slice(-4).join(" | ");
    step(`exam: grade ${exam.grade ?? "?"} — ${log}`);

    credits = await getCredits(sesskey);
    step(`credits now: ${credits}`);
    if (credits < TARGET && --maxNanos <= 0) { step("nano limit for this run reached"); break; }
  }

  console.log("\n========================================");
  console.log(`FINAL CREDITS: ${credits} (target ${TARGET}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(credits >= TARGET ? "TARGET MET ✓" : "target not met — check cooldowns/limits");
  process.exit(credits >= TARGET ? 0 : 1);
})().catch((e) => { console.error(`[!] ${e.message}`); process.exit(1); });
