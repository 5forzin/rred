#!/usr/bin/env node
/**
 * rred-exam — standalone Certification Exam solver (Puppeteer + LLM).
 *
 * Authorized scope: https://on.fiap.com.br/mod/quiz/* (purple-team
 * exercise by the FIAP security team). Flow proven in project phase 2:
 * login → preflight → one question per page (single/multi) → answer via
 * DeepSeek (OpenAI fallback) → summary → checkbox_finalizar → grade.
 *
 * Usage:
 *   RRED_RM=… RRED_PASSWORD=… DEEPSEEK_API_KEY=… \
 *   node scripts/rred-exam.mjs --cmid 584482 [--headed] [--provider openai]
 *
 * Output: per-question log and final grade; exit 0 with a parsed grade.
 */

import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import https from "node:https";

const BASE = "https://on.fiap.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- args/env

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]] : []))
);
const CMID = Number(args.cmid);
const HEADED = args.headed === true || args.headed === "true";
const PROVIDER = args.provider || "deepseek";
if (!CMID) { console.error("usage: node scripts/rred-exam.mjs --cmid <id>"); process.exit(2); }

const RM = process.env.RRED_RM, PW = process.env.RRED_PASSWORD;
if (!RM || !PW) { console.error("set RRED_RM and RRED_PASSWORD"); process.exit(2); }

const PROVIDERS = {
  deepseek: { url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", key: process.env.DEEPSEEK_API_KEY },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", key: process.env.OPENAI_API_KEY },
};
const P = PROVIDERS[PROVIDER];
if (!P?.key) { console.error(`set ${PROVIDER === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY"}`); process.exit(2); }

const t0 = Date.now();
const step = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------------------------------------------------------------- LLM

function postJSON(url, key, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Content-Length": Buffer.byteLength(data) } },
      (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { try { resolve(JSON.parse(s)); } catch { reject(new Error("non-JSON API response: " + s.slice(0, 120))); } }); }
    );
    req.on("error", reject); req.write(data); req.end();
  });
}

async function askLLM(text, options, kind) {
  const letters = "abcdefgh";
  const menu = options.map((o, i) => `${letters[i]}) ${o.label}`).join("\n");
  const multi = kind === "multi";
  const d = await postJSON(P.url, P.key, {
    model: P.model,
    messages: [
      { role: "system", content: multi
        ? "You are an expert taking technology certification exams in Portuguese. This question admits MULTIPLE correct answers. Reply ONLY with JSON {\"answers\":[\"<letter>\",...]} with every correct letter."
        : "You are an expert taking technology certification exams in Portuguese. Reply ONLY with JSON {\"answer\":\"<letter>\"} with the single correct letter." },
      { role: "user", content: `QUESTION:\n${text}\n\nOPTIONS:\n${menu}\n\nJSON:` },
    ],
    temperature: 0, max_tokens: 2000,
  });
  const txt = d.choices?.[0]?.message?.content || "";
  const bad = new Error(`LLM out of format: ${txt.slice(0, 120)}`);
  if (multi) {
    const m = /\{\s*"answers"\s*:\s*\[([^\]]*)\]/is.exec(txt) || /\[([^\]]*)\]/.exec(txt);
    if (!m) throw bad;
    const ls = [...m[1].matchAll(/"([a-h])"/gi)].map((x) => x[1].toLowerCase());
    if (!ls.length) throw bad;
    return [...new Set(ls)];
  }
  const m = /\{\s*"answer"\s*:\s*"([a-h])"\s*\}/i.exec(txt) || /"([a-h])"/i.exec(txt);
  if (!m) throw bad;
  return m[1].toLowerCase();
}

// ---------------------------------------------------------------- browser

async function findEdge() {
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ]) {
    try { execSync(`if exist "${p}" exit 0`, { shell: "cmd.exe" }); return p; } catch {}
  }
  throw new Error("no Edge/Chrome found");
}

const browser = await puppeteer.launch({
  executablePath: await findEdge(),
  headless: HEADED ? false : "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage();
await page.setUserAgent(UA);
page.setDefaultTimeout(20000);

try {
  // ---- login
  step("logging in…");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username-plataforma");
  await page.type("#username-plataforma", RM, { delay: 10 });
  await page.type("#password-plataforma", PW, { delay: 10 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.click("#loginbtn-plataforma"),
  ]);
  if (!page.url().includes("/local/home/")) throw new Error("login did not reach the home page: " + page.url());
  step("login ok");

  // ---- open the exam and pass the preflight ("I'm ready")
  step(`opening quiz ${CMID}…`);
  await page.goto(`${BASE}/mod/quiz/view.php?id=${CMID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button, input[type=submit]")].find((b) =>
      /Responder agora|Continuar|Retomar/i.test(b.textContent || b.value || "")
    );
    if (btn) btn.click();
  });
  await page.waitForSelector('[role="dialog"], input[name="checkbox_iniciar"]', { timeout: 6000 }).catch(() => {});
  const started = await page.evaluate(() => {
    const cb = document.querySelector('#checkbox-iniciar, input[name="checkbox_iniciar"]');
    if (cb) cb.click();
    const scope = document.querySelector('[role="dialog"]') || document;
    const btns = [...scope.querySelectorAll("button, input[type=submit]")].filter((b) => !b.disabled);
    const btn =
      btns.find((b) => /Responder agora|iniciar|começar/i.test(b.textContent || b.value || "")) ||
      [...scope.querySelectorAll("form")].find((f) => /startattempt|attempt\.php/.test(f.action))?.querySelector("button, input[type=submit]");
    if (btn) { btn.click(); return "preflight confirmed"; }
    return cb ? "checkbox ok, no button" : "no preflight";
  });
  step(started);
  await page.waitForFunction(() => /quiz\/attempt\.php/.test(location.href), { timeout: 20000 });
  step("attempt open: " + page.url().match(/attempt=(\d+)/)?.[1]);

  // ---- question loop
  const GETQ = `(() => {
    const qt = document.querySelector('.qtext');
    const radio = [...document.querySelectorAll('input[type=radio]')].find(i => /_answer$/.test(i.name));
    const cbx = [...document.querySelectorAll('input[type=checkbox]')].find(i => /_choice\\d+$/.test(i.name));
    const grab = (inputs) => inputs.map(i => ({ id: i.id,
      label: ((document.querySelector('label[for="'+i.id+'"]')||{}).textContent || '').trim() }));
    if (radio) return { kind:'single', field: radio.name, text: qt?qt.innerText.trim().slice(0,900):'',
      options: grab([...document.querySelectorAll('input[type=radio][name="'+radio.name+'"]')]) };
    if (cbx) { const base = cbx.name.replace(/_choice\\d+$/, '_choice');
      return { kind:'multi', field: base, text: qt?qt.innerText.trim().slice(0,900):'',
        options: grab([...document.querySelectorAll('input[type=checkbox]')].filter(i => i.name.startsWith(base))) }; }
    return null;
  })()`;

  let n = 0;
  while (true) {
    // wait for the question to settle (navigation sometimes delivers slowly)
    const WAITQ = `(() => { const r=[...document.querySelectorAll('input,textarea,select')].some(i=>/^q\\d+:\\d+_/.test(i.name)); return r || /quiz\\/(summary|review)\\.php/.test(location.href); })()`;
    try {
      await page.waitForFunction(WAITQ, { timeout: 30000, polling: 250 });
    } catch {
      const diag = await page.evaluate(() => ({
        url: location.href,
        inputs: document.querySelectorAll("input").length,
        body: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
      }));
      throw new Error(`question never appeared: ${JSON.stringify(diag)}`);
    }
    if (/quiz\/(summary|review)\.php/.test(page.url())) break;

    const q = await page.evaluate(GETQ);
    if (!q) { await new Promise((r) => setTimeout(r, 800)); continue; }
    n++;
    const letter = await askLLM(q.text, q.options, q.kind);
    const ids = q.kind === "multi"
      ? letter.map((l) => q.options[l.charCodeAt(0) - 97]?.id)
      : [q.options[letter.charCodeAt(0) - 97]?.id];
    if (ids.some((x) => !x)) throw new Error(`question ${n}: letter without option (${letter})`);

    const btnName = await page.evaluate((ids, kind) => {
      const click = (id) => { const el = document.querySelector(`label[for="${id}"]`) || document.getElementById(id); if (el) el.click(); };
      if (kind === "single") click(ids[0]); else ids.forEach(click);
      const btn = document.querySelector('input[type=submit][name=next], button[name=next], input[type=submit][name=finishattempt]');
      if (!btn) return null;
      btn.click();
      return btn.name;
    }, ids, q.kind);
    if (!btnName) throw new Error(`question ${n}: no advance button`);

    console.log(`  Q${String(n).padStart(2)} [${q.kind}] ${q.field} → AI: ${Array.isArray(letter) ? letter.join("") : letter} (${btnName})`);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  }
  step(` ${n} questions answered — at ${page.url().split("/").pop().split("?")[0]}`);

  // ---- finish (summary → checkbox_finalizar modal → submit)
  if (/quiz\/summary\.php/.test(page.url())) {
    await page.evaluate(() => {
      const btn = document.querySelector(".quizfinishbuttondiv button, form.singlebutton button, input[name=finishattempt], button[name=finishattempt]");
      if (btn) btn.click();
    });
    await page.waitForSelector('input[name="checkbox_finalizar"]', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => {
      const cb = document.querySelector('input[name="checkbox_finalizar"]');
      if (cb) cb.click();
    });
    await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') || document;
      const btns = [...dlg.querySelectorAll("button, input[type=submit]")].filter((b) => !b.disabled && /finalizar|enviar|confirmar/i.test(b.textContent || b.value || ""));
      if (btns.length) btns[btns.length - 1].click();
    });
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    step("attempt finished");
  }

  // ---- grade
  await page.waitForFunction(`!!document.querySelector('[data-finalgrade]')`, { timeout: 15000 }).catch(() => {});
  const grade = await page.evaluate(() => document.querySelector("[data-finalgrade]")?.getAttribute("data-finalgrade") || null);
  step(`FINAL GRADE: ${grade ?? "not found at " + page.url()}`);
  console.log(JSON.stringify({ cmid: CMID, questions: n, grade, provider: PROVIDER, seconds: ((Date.now() - t0) / 1000).toFixed(1) }));
  process.exitCode = grade ? 0 : 1;
} catch (e) {
  console.error(`[!] ${e.message}`);
  console.error("current url: " + page.url());
  process.exitCode = 1;
} finally {
  await browser.close();
}
