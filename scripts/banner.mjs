const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DURATION = 4200;
const SHADES = " ·:░▒▓█";
const TAG = "FIAP ON Nano Courses security assessment";
const LETTERS = {
  R: ["██████ ", "██   ██", "██   ██", "██████ ", "██ ██  ", "██  ██ ", "██   ██"],
  E: ["███████", "██     ", "██     ", "██████ ", "██     ", "██     ", "███████"],
  D: ["██████ ", "██   ██", "██   ██", "██   ██", "██   ██", "██   ██", "██████ "],
};
const LOGO = LETTERS.R.map((_, y) => [..."RRED"].map((letter) => LETTERS[letter][y]).join("  "));
const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const smooth = (a, b, n) => {
  const t = clamp((n - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const color = (r, g, b) => `${ESC}38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;

function logoLines(width) {
  if (width < LOGO[0].length + 4) return ["rred"];
  return width >= 80 ? LOGO.map((line) => [...line].map((c) => c + c).join("")) : LOGO;
}

function caption(cells, y, text, rgb) {
  if (!cells[y]) return;
  const fitted = text.slice(0, cells[y].length);
  const left = Math.floor((cells[y].length - fitted.length) / 2);
  for (let x = 0; x < fitted.length; x++) cells[y][left + x] = { char: fitted[x], rgb };
}

// Pure frame generation keeps rendering independent of terminal input and timing.
export function introFrame(columns, rows, progress) {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  const p = clamp(progress);
  const t = p * 9;
  const birth = smooth(0, 0.13, p);
  const settle = smooth(0.58, 0.89, p);
  const field = birth * (1 - settle * 0.94);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const cells = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const dx = (x - cx) / Math.max(1, width) * 3;
    const dy = (y - cy) / Math.max(1, height) * 2;
    const radius = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const twist = angle * 3 + radius * 9 - t * 2.4;
    const tunnel = Math.sin(radius * 19 - t * 4 + Math.sin(twist) * 1.8);
    const ripple = Math.sin(dx * 9 + Math.sin(dy * 7 + t) * 2 - t * 1.6);
    const fade = clamp(1 - radius * 0.46);
    const ink = clamp((tunnel * 0.28 + ripple * 0.15 + 0.49) * fade * field);
    const shade = Math.floor(ink * (SHADES.length - 1));
    const light = Math.round(ink * 8) / 8;
    return { char: SHADES[shade], rgb: [30 + light * 150, 3 + light * 15, 7 + light * 11] };
  }));

  const lines = logoLines(width);
  const left = Math.floor((width - lines[0].length) / 2);
  const top = Math.max(0, Math.floor((height - lines.length) / 2) - 1);
  const reveal = smooth(0.16, 0.48, p);
  const distortion = (1 - settle) * reveal;
  const scan = (p * 2.2 - 0.5) * lines[0].length;

  function stamp(offset, ghost) {
    const gain = ghost ? distortion * 0.48 : reveal;
    if (gain < 0.01) return;
    for (let y = 0; y < lines.length; y++) {
      const wave = Math.round((Math.sin(y * 0.85 + t * 2.1) * 4 + Math.sin(y * 1.9 - t) * 2) * distortion);
      const py = top + y;
      if (!cells[py]) continue;
      for (let x = 0; x < lines[y].length; x++) {
        if (lines[y][x] === " ") continue;
        const px = left + x + wave + offset;
        if (px < 0 || px >= width) continue;
        const shimmer = (Math.sin(x * 0.13 - t * 2 + y * 0.4) + 1) / 2;
        const highlight = Math.exp(-(((x - scan) / 5) ** 2)) * (1 - settle);
        const intensity = ghost ? 95 * gain : (200 + shimmer * 50) * gain;
        cells[py][px] = {
          char: lines[y][x] !== "█" ? lines[y][x] : ghost ? "░" : (gain < 0.4 ? "▒" : gain < 0.8 ? "▓" : "█"),
          rgb: [clamp(intensity + highlight * 35, 0, 255), ghost ? 8 * gain : (24 + shimmer * 36 + highlight * 90) * gain,
            ghost ? 12 * gain : (18 + shimmer * 18 + highlight * 45) * gain],
        };
      }
    }
  }

  const trail = Math.round(3 + (Math.sin(t * 1.7) + 1) * 4);
  stamp(-trail, true);
  stamp(trail, true);
  stamp(0, false);

  const tagY = top + lines.length + 2;
  if (p > 0.73 && height > lines.length + 4) {
    const visible = Math.ceil(TAG.length * smooth(0.73, 0.94, p));
    caption(cells, tagY, TAG.slice(0, visible).padEnd(Math.min(TAG.length, width)), [166, 62, 57]);
  }
  if (height >= 18 && p < 0.96) caption(cells, height - 2, "ENTER / SPACE TO SKIP", [105, 34, 34]);

  return cells.map((row) => {
    let line = "", lastColor = "";
    for (const cell of row) {
      const nextColor = color(...cell.rgb);
      if (cell.char !== " " && nextColor !== lastColor) { line += nextColor; lastColor = nextColor; }
      line += cell.char;
    }
    return line + RESET + `${ESC}K`;
  }).join("\r\n");
}

function staticBanner(output, ansi) {
  const width = Math.max(1, (output.columns || 80) - 1);
  const lines = logoLines(width);
  const indent = " ".repeat(Math.max(0, Math.min(6, Math.floor((width - lines[0].length) / 2))));
  const text = lines.map((line, i) => `${ansi ? color(255 - i * 8, 52 - i * 4, 38 - i * 2) : ""}${indent}${line.trimEnd()}`).join("\n");
  output.write(`\n${text}${ansi ? RESET : ""}\n\n${indent}${TAG.slice(0, width - indent.length)}\n\n`);
}

export async function playIntro({ output = process.stdout, input = process.stdin, duration = DURATION } = {}) {
  if (!output.isTTY || process.env.TERM === "dumb") { staticBanner(output, false); return true; }
  const canRead = input.isTTY && typeof input.setRawMode === "function";
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  let skipped = false, interrupted = false, active = false;
  const onKey = (data) => {
    const keys = data.toString();
    if (keys.includes("\x03")) { interrupted = true; skipped = true; }
    if (/[\r\n ]/.test(keys)) skipped = true;
  };
  const restoreScreen = () => {
    if (!active) return;
    active = false;
    output.write(`${RESET}${ESC}?25h${ESC}?1049l`);
  };
  const onSignal = () => { interrupted = true; skipped = true; };
  try {
    active = true;
    process.once("exit", restoreScreen);
    process.once("SIGINT", onSignal);
    if (canRead) {
      input.setRawMode(true);
      input.on("data", onKey);
      input.resume();
    }
    output.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    const start = performance.now();
    while (!skipped) {
      const elapsed = performance.now() - start;
      const width = Math.min(112, Math.max(1, (output.columns || 80) - 1));
      const height = Math.min(28, Math.max(1, (output.rows || 24) - 1));
      output.write(`${ESC}H${introFrame(width, height, elapsed / duration)}${ESC}J`);
      if (elapsed >= duration) break;
      await new Promise((resolve) => setTimeout(resolve, 33));
    }
  } finally {
    if (canRead) {
      input.removeListener("data", onKey);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
    }
    restoreScreen();
    process.removeListener("exit", restoreScreen);
    process.removeListener("SIGINT", onSignal);
  }
  if (interrupted) { process.exitCode = 130; return false; }
  staticBanner(output, true);
  return true;
}
