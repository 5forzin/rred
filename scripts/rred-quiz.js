#!/usr/bin/env node
/**
 * Versão experimental da prova de certificação via HTTP, sem navegador.
 *
 * Escopo autorizado: https://on.fiap.com.br/mod/quiz/*
 * Inicia a tentativa, lê cada questão, pede uma resposta ao modelo e envia
 * o formulário. Nos dois testes, as respostas foram salvas, mas a nota foi
 * zero. A causa ainda não foi identificada; veja a análise técnica, §6.4.
 *
 * Uso:
 *   RRED_RM=… RRED_PASSWORD=… [DEEPSEEK_API_KEY=…] [OPENAI_API_KEY=…] node scripts/rred-quiz.js \
 *       --cmid 568560 [--provider deepseek|openai] [--model nome] [--dry-run] [--review <attemptId>]
 */

const BASE = "https://on.fiap.com.br";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const t0 = Date.now();
const step = (m) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { provider: process.env.RRED_PROVIDER || "deepseek" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cmid") out.cmid = Number(argv[++i]);
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--review") out.review = Number(argv[++i]);
    else { console.error(`argumento desconhecido: ${a}`); process.exit(2); }
  }
  return out;
}

// ---------------------------------------------------------------- http

let cookies = {}; // Cookies da sessão, por nome.

async function http(path, { method = "GET", body, headers = {} } = {}) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: { "User-Agent": UA, ...(jar && { Cookie: jar }), ...headers },
    body,
  });
  // Guarda os cookies de cada resposta, incluindo múltiplos Set-Cookie.
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of raw.length ? raw : (res.headers.get("set-cookie") || "").split(/,(?=[^;]+?=)/)) {
    const m = /^\s*([a-zA-Z0-9_]+)=([^;]*)/.exec(c);
    if (m) cookies[m[1]] = m[2];
  }
  const m2 = /MoodleSession=([a-zA-Z0-9]+)/.exec(res.headers.get("set-cookie") || "");
  if (m2) cookies.MoodleSession = m2[1];
  return res;
}

const formBody = (obj) =>
  Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

async function login(rm, password) {
  await http("/index.php");
  const res = await http("/index.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ username: rm, password, v: "plataforma" }),
  });
  const loc = res.headers.get("location") || "";
  if (res.status !== 303 || !loc.includes("/local/home/")) throw new Error(`login recusado (HTTP ${res.status})`);
  step(`Login concluído (${Object.keys(cookies).length} cookies na sessão)`);
}

async function getSesskey() {
  const res = await http("/local/home/index.php");
  const html = await res.text();
  const m = /"sesskey":"([^"]+)"/.exec(html);
  if (!m) throw new Error("sesskey não encontrado");
  return m[1];
}

/** Envia o formulário e segue um redirecionamento, retornando URL e HTML. */
async function postFollow(path, fields, { multipart = false, referer = null } = {}) {
  let body, headers = {};
  if (multipart) {
    // Usa multipart/form-data, conforme o enctype do formulário.
    const bd = "----rred" + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`--${bd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    parts.push(`--${bd}--\r\n`);
    body = parts.join("");
    headers["Content-Type"] = `multipart/form-data; boundary=${bd}`;
  } else {
    body = formBody(fields);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (referer) headers["Referer"] = referer;
  const res = await http(path, { method: "POST", body, headers });
  if (res.status >= 300 && res.status < 400) {
    const loc = (res.headers.get("location") || "").replace(BASE, "");
    const r2 = await http(loc);
    return { url: loc, status: res.status, html: await r2.text() };
  }
  return { url: path, status: res.status, html: await res.text() };
}

// ---------------------------------------------------------------- LLM

const PROVIDERS = {
  deepseek: { url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", keyEnv: "DEEPSEEK_API_KEY" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
};

async function askLLM(provider, model, question, options, kind) {
  const p = PROVIDERS[provider];
  const key = process.env[p.keyEnv];
  if (!key) throw new Error(`defina ${p.keyEnv} no ambiente`);
  const letters = "abcdefgh";
  const menu = options.map((o, i) => `${letters[i]}) ${o.label}`).join("\n");
  const multi = kind === "multi";
  const system = multi
    ? "Responda à questão de certificação de tecnologia em português. Pode haver mais de uma alternativa correta. Retorne somente JSON {\"answers\":[\"<letra>\",…]} com todas as letras corretas e ao menos uma resposta."
    : "Responda à questão de certificação de tecnologia em português. Escolha uma alternativa correta. Retorne somente JSON {\"answer\":\"<letra>\"} com a letra escolhida.";
  const user = `QUESTÃO:\n${question}\n\nALTERNATIVAS:\n${menu}\n\nJSON ${multi ? "com as letras corretas" : "com a letra correta"}:`;
  const body = {
    model: model || p.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0,
    max_tokens: 2000,
  };
  const res = await fetch(p.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const txt = data.choices?.[0]?.message?.content || "";

  const toIdx = (l) => {
    const i = l.toLowerCase().charCodeAt(0) - 97;
    if (i < 0 || i >= options.length) throw new Error(`letra "${l}" fora do intervalo`);
    return i;
  };
  if (multi) {
    const m = /\{\s*"answers"\s*:\s*\[([^\]]*)\]/is.exec(txt) || /\[([^\]]*)\]/.exec(txt);
    if (!m) throw new Error(`resposta do LLM fora do formato: ${txt.slice(0, 120)}`);
    const ls = [...m[1].matchAll(/"([a-h])"/gi)].map((x) => x[1].toLowerCase());
    const uniq = [...new Set(ls)];
    if (!uniq.length) throw new Error("nenhuma letra retornada");
    return { letters: uniq, indexes: uniq.map(toIdx), raw: txt.slice(0, 300) };
  }
  const m = /\{\s*"answer"\s*:\s*"([a-h])"\s*\}/i.exec(txt) || /"([a-h])"/i.exec(txt);
  if (!m) throw new Error(`resposta do LLM fora do formato: ${txt.slice(0, 120)}`);
  return { letter: m[1].toLowerCase(), index: toIdx(m[1]), raw: txt.slice(0, 300) };
}

// ---------------------------------------------------------------- quiz

const { parseAttemptPage, parseReviewPage } = require("./quiz-parse");

async function startAttempt(cmid, sesskey) {
  const base = { cmid, sesskey };
  // 1º POST: Moodle devolve o preflight (checkbox "estou pronto")
  let r = await postFollow(`/mod/quiz/startattempt.php?cmid=${cmid}&sesskey=${sesskey}`, base);
  if (r.html.includes("mod_quiz_preflight_form")) {
    step("preflight: confirmando 'estou pronto'");
    r = await postFollow(`/mod/quiz/startattempt.php?cmid=${cmid}&sesskey=${sesskey}`, {
      ...base,
      _qf__mod_quiz_preflight_check_form: 1,
      checkbox_iniciar: 1,
    });
  }
  const m = /attempt=(\d+)/.exec(r.url) || /attempt=(\d+)/.exec(r.html);
  if (!m) throw new Error("não foi possível iniciar a tentativa (sem attempt id)");
  step(`tentativa iniciada: ${m[1]}`);
  return { attemptId: m[1], firstPageHtml: r.html };
}

async function runAttempt(cmid, attemptId, firstPageHtml, { provider, model, dryRun }) {
  let html = firstPageHtml;
  let page = 0;
  let answers = [];
  let sesskey = null;
  while (true) {
    const parsed = parseAttemptPage(html);
    if (!parsed.question) throw new Error(`Não foi possível ler a questão da página ${page}.`);
    const q = parsed.question;
    const letters = "abcdefgh";
    console.log(`\n— Página ${page} | ${q.kind} | q${q.qid}:${q.slot}_`);
    console.log(`  ${q.text.slice(0, 220)}${q.text.length > 220 ? "…" : ""}`);
    q.options.forEach((o, i) => console.log(`   ${letters[i]}) ${o.label.slice(0, 100)}`));

    const ans = await askLLM(provider, model, q.text, q.options, q.kind);
    if (dryRun) {
      console.log("  → IA:", q.kind === "multi" ? ans.letters.join(",") : ans.letter);
      step("Dry-run: resposta consultada, sem envio ao portal."); break;
    }

    // Mantém os campos ocultos e adiciona a resposta e o botão de envio.
    const fields = {};
    for (const [k, v] of Object.entries(parsed.hidden)) {
      if (k === "busca-menu") continue;
      fields[k] = v;
    }
    sesskey = fields.sesskey;

    if (q.kind === "multi") {
      const sel = new Set(ans.indexes);
      for (const o of q.options) fields[`${q.qid}:${q.slot}_choice${o.choice}`] = sel.has(o.choice) ? "1" : "0";
      console.log(`  → IA (${provider}): ${ans.letters.join(", ")}`);
      answers.push({ page, qid: q.qid, letters: ans.letters });
    } else {
      const chosen = q.options[ans.index];
      fields[`${q.qid}:${q.slot}_answer`] = chosen.value;
      console.log(`  → IA (${provider}): ${ans.letter}) ${chosen.label.slice(0, 100)}`);
      answers.push({ page, qid: q.qid, letter: ans.letter, value: chosen.value });
    }
    fields.timeup = "0";
    const submit = parsed.submits.includes("finishattempt") ? "finishattempt" : "next";
    fields[submit] = submit === "next" ? "Próxima pergunta" : "Finalizar";

    const realPage = parsed.page; // thispage real do form, não o contador
    const referer = `${BASE}/mod/quiz/attempt.php?attempt=${attemptId}&cmid=${cmid}${realPage !== "0" ? `&page=${realPage}` : ""}`;
    require("fs").writeFileSync(`.recon/quiz-post-p${realPage}.body`, formBody(fields));
    const r = await postFollow("/mod/quiz/processattempt.php", fields, { referer });

    // Após o envio, espera uma página de tentativa, resumo ou resultado.
    const landedOk =
      /\/mod\/quiz\/(attempt|summary|review)\.php/.test(r.url) || /q\d+:\d+_/.test(r.html);
    if (!landedOk) {
      require("fs").writeFileSync(".recon/quiz-err-page.html", r.html);
      const em = /errormessage">([^<]*)/.exec(r.html);
      throw new Error(`POST da página ${page} falhou: ${em ? em[1] : `HTTP ${r.status} sem questão`}`);
    }

    // Consulta o HTML novamente para verificar a indicação de resposta salva
    // e registrar o sequencecheck atual.
    {
      const chk = await http(`/mod/quiz/attempt.php?attempt=${attemptId}&cmid=${cmid}&page=${realPage}`);
      const chtml = await chk.text();
      const nav = new RegExp(`id="quiznavbutton${q.slot}"[^>]*title="([^"]*)"`).exec(chtml);
      const seqNow = new RegExp(`${q.qid}:${q.slot}_:sequencecheck"[^>]*value="(\\d+)"`).exec(chtml);
      const seqWas = parsed.hidden[`${q.qid}:${q.slot}_:sequencecheck`];
      const saved = nav && /Resposta salva/.test(nav[1]);
      if (!saved) {
        require("fs").writeFileSync(`.recon/quiz-nopersist-p${realPage}.html`, chtml);
        throw new Error(
          `Questão ${q.slot}: resposta não salva. Navegação: "${nav ? nav[1] : "?"}", ` +
          `seqcheck ${seqWas}→${seqNow ? seqNow[1] : "?"}`
        );
      }
      step(`Questão ${q.slot}: resposta salva (seqcheck ${seqWas}→${seqNow?.[1]}, navegação: "${nav[1]}")`);
    }

    // A última página leva ao resumo ou diretamente ao resultado.
    if (r.url.includes("summary.php")) {
      step("Respostas concluídas. Confirmando o envio final.");
      const r2 = await postFollow("/mod/quiz/processattempt.php", {
        attempt: attemptId, finishattempt: "1", timeup: "0", slots: "", cmid: String(cmid), sesskey,
        checkbox_finalizar: "1",
      }, { referer: `${BASE}/mod/quiz/summary.php?attempt=${attemptId}&cmid=${cmid}` });
      html = r2.html;
      break;
    }
    if (r.url.includes("review.php")) { html = r.html; break; }
    if (r.url.includes("view.php")) { html = r.html; break; }
    html = r.html;
    page++;
    await sleep(300);
  }
  return answers;
}

async function showReview(attemptId) {
  const res = await http(`/mod/quiz/review.php?attempt=${attemptId}`);
  const html = await res.text();
  const rev = parseReviewPage(html);
  console.log("\nResultado da tentativa:");
  if (rev.overall) console.log("nota geral:", rev.overall);
  rev.questions.forEach((q) => console.log(`  questão ${q.id}: ${q.correctness ?? "?"} ${q.grade ?? ""}`));
  return rev;
}

// ---------------------------------------------------------------- main

(async () => {
  const args = parseArgs(process.argv);
  const rm = process.env.RRED_RM, password = process.env.RRED_PASSWORD;
  if (!rm || !password) { console.error("defina RRED_RM e RRED_PASSWORD"); process.exit(2); }

  await login(rm, password);
  const sesskey = await getSesskey();

  if (args.review) { await showReview(args.review); process.exit(0); }

  const cmid = args.cmid || 568560;
  const { attemptId, firstPageHtml } = await startAttempt(cmid, sesskey);
  const answers = await runAttempt(cmid, attemptId, firstPageHtml, args);
  step(`${answers.length} questões respondidas`);
  if (!args.dryRun) {
    await sleep(1000);
    await showReview(attemptId);
  }
  step("concluído");
  process.exit(0);
})().catch((e) => { console.error(`[!] ${e.message}`); process.exit(1); });
