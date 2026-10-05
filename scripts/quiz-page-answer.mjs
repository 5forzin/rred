/**
 * Read a saved quiz page, request an answer and print the URL-encoded
 * form body for processattempt. Exit 42 means no question was found.
 *
 * Usage: node scripts/quiz-page-answer.mjs <file.html> [--provider deepseek|openai]
 */
import fs from "node:fs";
import { parseAttemptPage } from "./quiz-parse.js";

const file = process.argv[2];
const providerIdx = process.argv.indexOf("--provider");
const provider = providerIdx > 0 ? process.argv[providerIdx + 1] : "deepseek";

const PROVIDERS = {
  deepseek: { url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", keyEnv: "DEEPSEEK_API_KEY" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
};

async function askLLM(question, options, kind) {
  const p = PROVIDERS[provider];
  const key = process.env[p.keyEnv];
  if (!key) throw new Error(`Set ${p.keyEnv} in the environment.`);
  const letters = "abcdefgh";
  const menu = options.map((o, i) => `${letters[i]}) ${o.label}`).join("\n");
  const multi = kind === "multi";
  const system = multi
    ? "Answer this technology certification question in Portuguese. More than one option can be correct. Return only JSON {\"answers\":[\"<letter>\",...]} with all correct letters."
    : "Answer this technology certification question in Portuguese. Choose one correct option. Return only JSON {\"answer\":\"<letter>\"} with its letter.";
  const res = await fetch(p.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: p.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `QUESTION:\n${question}\n\nOPTIONS:\n${menu}\n\nJSON:` },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const txt = (await res.json()).choices?.[0]?.message?.content || "";
  const toIdx = (l) => {
    const i = l.toLowerCase().charCodeAt(0) - 97;
    if (i < 0 || i >= options.length) throw new Error(`No option matches the returned letter ${l}.`);
    return i;
  };
  if (multi) {
    const m = /\{\s*"answers"\s*:\s*\[([^\]]*)\]/is.exec(txt) || /\[([^\]]*)\]/.exec(txt);
    const ls = [...(m?.[1] || "").matchAll(/"([a-h])"/gi)].map((x) => x[1].toLowerCase());
    return { indexes: [...new Set(ls)].map(toIdx), letters: ls };
  }
  const m = /\{\s*"answer"\s*:\s*"([a-h])"\s*\}/i.exec(txt) || /"([a-h])"/i.exec(txt);
  if (!m) throw new Error(`The model returned an unexpected answer format: ${txt.slice(0, 100)}`);
  return { index: toIdx(m[1]), letter: m[1].toLowerCase() };
}

const html = fs.readFileSync(file, "utf8");
const parsed = parseAttemptPage(html);
if (!parsed.question) {
  console.error("No question could be read from this page.");
  process.exit(42);
}
const q = parsed.question;
const ans = await askLLM(q.text, q.options, q.kind);
console.error(`Question ${q.slot} (${q.kind}): selected ${q.kind === "multi" ? ans.letters.join(", ") : ans.letter}`);

const fields = {};
for (const [k, v] of Object.entries(parsed.hidden)) if (k !== "busca-menu") fields[k] = v;
if (q.kind === "multi") {
  const sel = new Set(ans.indexes);
  for (const o of q.options) fields[`${q.qid}:${q.slot}_choice${o.choice}`] = sel.has(o.choice) ? "1" : "0";
} else {
  fields[`${q.qid}:${q.slot}_answer`] = q.options[ans.index].value;
}
fields.timeup = "0";
fields.next = "Próxima pergunta";

console.log(Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"));
