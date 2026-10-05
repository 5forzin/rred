#!/usr/bin/env node
/**
 * Command-line menu for the rred assessment scripts.
 *
 * Authorized purple-team assessment of FIAP ON Nano Courses
 * (scope: https://on.fiap.com.br/nano-courses/* and /mod/quiz/*).
 *
 * Usage:
 *   node cli.mjs                       interactive menu
 *   node cli.mjs status                list courses and progress
 *   node cli.mjs complete <courseId>   enroll and mark video progress
 *   node cli.mjs exam <cmid>           answer an exam using a browser and LLM
 *   node cli.mjs auto [N]              run courses until the credit target
 *   --no-banner                        skip the animation
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ask, ensureCredentials } from "./scripts/lib-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_BANNER = process.argv.includes("--no-banner") || !!process.env.RRED_NO_BANNER;
const args = process.argv.slice(2).filter((a) => a !== "--no-banner");
const has = (x) => args.includes(x);

// ---------------------------------------------------------------- banner

const LOGO = String.raw`
 ██████  ██████  ███████  ██████
 ██      ██    ██ ██      ██
 ██      ██    ██ █████   ██
 ██████  ██████  ███████ ██
`;
const TAG = "FIAP ON Nano Courses security assessment";

function gradient(i, n, s) {
  // Interpolate between pink, magenta and cyan.
  const stops = [[237, 20, 91], [155, 39, 167], [56, 189, 248]];
  const t = Math.min(0.9999, Math.max(0, i / Math.max(1, n - 1))) * (stops.length - 1);
  const a = stops[Math.floor(t)], b = stops[Math.ceil(t)];
  const k = t - Math.floor(t);
  const c = a.map((v, j) => Math.round(v + (b[j] - v) * k));
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[0m`;
}

async function banner() {
  if (NO_BANNER) return;
  const lines = LOGO.split("\n").filter((l) => l.length);
  const w = Math.max(...lines.map((l) => l.length));

  // Replace random characters with the logo over eight frames.
  const CHARS = "▓▒░#/\\|<>[]{}=+*";
  for (let f = 0; f < 8; f++) {
    process.stdout.write("\x1b[H\x1b[2J");
    lines.forEach((l, y) => {
      let out = "";
      for (let x = 0; x < w; x++) {
        const reveal = (y * w + x) / (lines.length * w);
        const noisy = f / 8 < reveal;
        out += noisy ? l[x] ?? " " : CHARS[(Math.random() * CHARS.length) | 0];
      }
      process.stdout.write("  " + gradient(f, 8, out) + "\r\n");
    });
    await sleep(45);
  }

  // Reveal the logo, then the description.
  process.stdout.write("\x1b[H\x1b[2J");
  for (let p = 0; p <= lines[0].length; p++) {
    process.stdout.write("\x1b[H");
    lines.forEach((l) => {
      process.stdout.write("  " + gradient(p, w, l.slice(0, p)) + "\r\n");
    });
    await sleep(14);
  }
  const tag = "  " + TAG;
  for (let i = 0; i <= tag.length; i += 2) {
    process.stdout.write("\x1b[s");
    process.stdout.write("\x1b[" + (lines.length + 1) + ";1H\x1b[2K");
    process.stdout.write(gradient(1, 2, tag.slice(0, i)));
    process.stdout.write("\x1b[u");
    await sleep(12);
  }
  process.stdout.write("\x1b[" + (lines.length + 1) + ";1H\x1b[2K  \x1b[2m" + TAG + "\x1b[0m\n\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- menu

function run(script, scriptArgs = []) {
  const r = spawnSync(process.execPath, [join(HERE, "scripts", script), ...scriptArgs], {
    stdio: "inherit",
    env: process.env,
  });
  return r.status === 0;
}

async function menu() {
  await ensureCredentials();
  while (true) {
    console.log("\x1b[1mWhat do you want to do?\x1b[0m");
    console.log("  \x1b[36m1\x1b[0m  View courses and progress");
    console.log("  \x1b[36m2\x1b[0m  Mark a course complete");
    console.log("  \x1b[36m3\x1b[0m  Answer a certification exam");
    console.log("  \x1b[36m4\x1b[0m  Run courses to a credit target");
    console.log("  \x1b[36m5\x1b[0m  Exit");
    const c = await ask("\nChoose an option: ");
    console.log();
    if (c === "1") { run("rred.js", ["--list"]); }
    else if (c === "2") { const id = await ask("Course ID: "); if (id) run("rred.js", ["--course", id]); }
    else if (c === "3") { await ensureCredentials({ llm: true }); const id = await ask("Exam ID (cmid): "); if (id) run("rred-exam.mjs", ["--cmid", id]); }
    else if (c === "4") { await ensureCredentials({ llm: true }); const t = (await ask("Credit target [20]: ")) || "20"; run("rred-auto.mjs", ["--target", t]); }
    else if (c === "5" || c === "q") { console.log("Goodbye."); process.exit(0); }
    else console.log("Choose a number from 1 to 5.");
    console.log();
  }
}

// ---------------------------------------------------------------- main

await banner();
if (has("status")) { await ensureCredentials(); process.exit(run("rred.js", ["--list"]) ? 0 : 1); }
if (has("complete")) { await ensureCredentials(); const id = args[args.indexOf("complete") + 1]; if (!id) { console.error("usage: node cli.mjs complete <courseId>"); process.exit(2); } process.exit(run("rred.js", ["--course", id]) ? 0 : 1); }
if (has("exam")) { await ensureCredentials({ llm: true }); const id = args[args.indexOf("exam") + 1]; if (!id) { console.error("usage: node cli.mjs exam <cmid>"); process.exit(2); } process.exit(run("rred-exam.mjs", ["--cmid", id]) ? 0 : 1); }
if (has("auto")) { await ensureCredentials({ llm: true }); const t = args[args.indexOf("auto") + 1]; process.exit(run("rred-auto.mjs", ["--target", t || "20"]) ? 0 : 1); }
if (args.length) { console.error("Unknown command. Run node cli.mjs to open the menu."); process.exit(2); }
await menu();
