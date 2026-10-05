#!/usr/bin/env node
/**
 * Command-line menu for the rred assessment scripts.
 *
 * Security assessment of FIAP ON Nano Courses
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
import { playIntro } from "./scripts/banner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_BANNER = process.argv.includes("--no-banner") || !!process.env.RRED_NO_BANNER;
const args = process.argv.slice(2).filter((a) => a !== "--no-banner");
const has = (x) => args.includes(x);

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
    console.log("  \x1b[91m1\x1b[0m  View courses and progress");
    console.log("  \x1b[91m2\x1b[0m  Mark a course complete");
    console.log("  \x1b[91m3\x1b[0m  Answer a certification exam");
    console.log("  \x1b[91m4\x1b[0m  Run courses to a credit target");
    console.log("  \x1b[91m5\x1b[0m  Exit");
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

if (!NO_BANNER && (await playIntro()) === false) process.exit(130);
if (has("status")) { await ensureCredentials(); process.exit(run("rred.js", ["--list"]) ? 0 : 1); }
if (has("complete")) { await ensureCredentials(); const id = args[args.indexOf("complete") + 1]; if (!id) { console.error("usage: node cli.mjs complete <courseId>"); process.exit(2); } process.exit(run("rred.js", ["--course", id]) ? 0 : 1); }
if (has("exam")) { await ensureCredentials({ llm: true }); const id = args[args.indexOf("exam") + 1]; if (!id) { console.error("usage: node cli.mjs exam <cmid>"); process.exit(2); } process.exit(run("rred-exam.mjs", ["--cmid", id]) ? 0 : 1); }
if (has("auto")) { await ensureCredentials({ llm: true }); const t = args[args.indexOf("auto") + 1]; process.exit(run("rred-auto.mjs", ["--target", t || "20"]) ? 0 : 1); }
if (args.length) { console.error("Unknown command. Run node cli.mjs to open the menu."); process.exit(2); }
await menu();
