/**
 * Load .env and ask for missing credentials using Node's built-in modules.
 *
 * Use existing environment variables first, then .env, then prompts.
 */
import fs from "node:fs";
import readline from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Parses a simple KEY=VALUE .env file (quotes optional, # comments). */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Loads .env from the project root into process.env (without overriding). */
export function loadEnvFile(path = join(PROJECT_ROOT, ".env")) {
  try {
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(path, "utf8")))) {
      if (!(k in process.env)) process.env[k] = v;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- prompt

// Queue input lines so piped answers are not lost between prompts.
let rlSingleton = null;
const lineQueue = [];
let lineWaiter = null;

function getRl() {
  if (!rlSingleton) {
    rlSingleton = readline.createInterface({ input: process.stdin, output: process.stdout });
    rlSingleton.on("line", (l) => {
      if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); }
      else lineQueue.push(l);
    });
  }
  return rlSingleton;
}

export function ask(question, hidden = false) {
  return new Promise((resolve) => {
    getRl();
    process.stdout.write(question);
    const take = (l) => {
      if (hidden) process.stdout.write("\n");
      resolve(String(l).trim());
    };
    if (lineQueue.length) { take(lineQueue.shift()); return; }
    lineWaiter = take;
  });
}

/**
 * Ask for missing portal credentials and offer to save them to .env.
 * With { llm: true }, also ask for a DeepSeek key if neither provider is set.
 */
export async function ensureCredentials({ llm = false } = {}) {
  loadEnvFile();
  const needSave = {};

  if (!process.env.RRED_RM) {
    process.env.RRED_RM = await ask("Portal username (RM): ");
    needSave.RRED_RM = process.env.RRED_RM;
  }
  if (!process.env.RRED_PASSWORD) {
    process.env.RRED_PASSWORD = await ask("Portal password: ", true);
    needSave.RRED_PASSWORD = process.env.RRED_PASSWORD;
  }
  if (llm && !process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY) {
    process.env.DEEPSEEK_API_KEY = await ask("DeepSeek API key (press Enter to skip): ", true);
    if (process.env.DEEPSEEK_API_KEY) needSave.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  }

  if (Object.keys(needSave).length) {
    const save = (await ask("Save these values to .env? [y/N] ")).toLowerCase() === "y";
    if (save) {
      const body = Object.entries(needSave).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n");
      fs.writeFileSync(join(PROJECT_ROOT, ".env"), body + "\n", { flag: "a" });
      console.log("Saved to .env, which is excluded from Git by default.");
    }
  }
}
