/**
 * Parse questions and grades from the FIAP Moodle quiz HTML.
 * Tested pages contain one question, with .qtext and _answer radio fields
 * or _choiceN checkbox fields.
 */
const fs = require("fs");

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Read the label linked to an input by its for attribute. */
function labelFor(html, id) {
  const re = new RegExp(`for="${id}"[^>]*>([\\s\\S]{0,600}?)</label>`, "s");
  const m = re.exec(html);
  return m ? stripTags(m[1]) : "";
}

function parseAttemptPage(html) {
  const out = { hidden: {}, question: null, submits: [], page: null, nextPage: null };

  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const tag = m[0];
    const n = /name="([^"]+)"/.exec(tag);
    const v = /value="([^"]*)"/.exec(tag);
    if (n) out.hidden[n[1]] = v ? decode(v[1]) : "";
  }
  for (const m of html.matchAll(/<input[^>]*type="submit"[^>]*>/g)) {
    const n = /name="([^"]+)"/.exec(m[0]);
    if (n) out.submits.push(n[1]);
  }
  const t = /name="thispage"[^>]*value="(\d+)"/.exec(html);
  const nx = /name="nextpage"[^>]*value="(-?\d+)"/.exec(html);
  out.page = t ? t[1] : "0";
  out.nextPage = nx ? nx[1] : "-1";

  const qt = /<div[^>]*class="qtext"[^>]*>([\s\S]*?)<\/div>/s.exec(html);
  const text = qt ? stripTags(qt[1]) : "";

  // Single-answer questions use _answer radio fields.
  const radio = /name="q(\d+):(\d+)_answer"/.exec(html);
  if (radio) {
    const [, qid, slot] = radio;
    const options = [];
    for (const m of html.matchAll(/<input[^>]*type="radio"[^>]*name="q\d+:\d+_answer"[^>]*>/g)) {
      const value = /value="(\d+)"/.exec(m[0])?.[1] ?? "0";
      const id = /id="([^"]+)"/.exec(m[0])?.[1] || "";
      options.push({ value, label: labelFor(html, id) });
    }
    options.sort((a, b) => Number(a.value) - Number(b.value));
    out.question = { qid, slot, kind: "single", text, options };
    return out;
  }

  // Multiple-answer questions use hidden and checkbox _choiceN fields.
  const cbx = /name="q(\d+):(\d+)_choice(\d+)"/.exec(html);
  if (cbx) {
    const [, qid, slot] = cbx;
    const idxs = [...new Set([...html.matchAll(/name="q\d+:\d+_choice(\d+)"/g)].map((x) => x[1]))].sort((a, b) => a - b);
    const options = idxs.map((i) => {
      const id = `q${qid}:${slot}_choice${i}`;
      return { choice: i, label: labelFor(html, id) };
    });
    out.question = { qid, slot, kind: "multi", text, options };
    return out;
  }

  return out;
}

/** Review page: final grade (the FIAP skin hides per-question details). */
function parseReviewPage(html) {
  const out = { finalGrade: null };
  const g = /data-finalgrade="([^"]*)"/.exec(html);
  if (g) out.finalGrade = g[1];
  return out;
}

if (require.main === module && process.argv[2]) {
  const html = fs.readFileSync(process.argv[2], "utf8");
  if (process.argv.includes("--review")) {
    console.log(JSON.stringify(parseReviewPage(html), null, 1));
  } else {
    console.log(JSON.stringify(parseAttemptPage(html), null, 1));
  }
}

module.exports = { parseAttemptPage, parseReviewPage, stripTags };
