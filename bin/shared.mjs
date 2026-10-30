import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.dirname(BIN_DIR);
export const HOME = (process.env.RUODAO_PLAZA_HOME || "").trim() || path.join(os.homedir(), ".ruodao", "music-plaza");
export const ENGINE_DIR = path.join(HOME, "engine");
export const VENV_DIR = path.join(ENGINE_DIR, "venv");
export const VENV_PY = path.join(VENV_DIR, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
// 没有 venv（Windows 随包 embeddable Python 就是这种）时的私有依赖目录：
// pip --target 装到这里，运行时由 _pth / PYTHONPATH 注入，不污染系统 Python。
export const ENGINE_SITE_DIR = path.join(ENGINE_DIR, "site-packages");
export const ENGINE_STATE = path.join(HOME, "engine-state.json");
export const INSTALL_STATE = path.join(HOME, "install-state.json");
export const INSTALL_LOG = path.join(HOME, "install.log");
export const SERVER_PID = path.join(HOME, "server.pid");
export const SERVER_LOG = path.join(HOME, "server.log");
export const SERVER_JSON = path.join(HOME, "server.json");
export const PY_SCRIPT = path.join(PLUGIN_ROOT, "python", "musicdl_search.py");
export const SERVER_SCRIPT = path.join(PLUGIN_ROOT, "bin", "plaza-server.mjs");

export const env = (key, fallback = "") => String(process.env[key] ?? fallback).trim();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, file);
}

export function tailFile(file, maxLines = 40) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

export function run(cmd, args, { timeout = 30000, cwd, env: extraEnv, onLine } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(extraEnv || {}) },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, code: -1, stdout, stderr: String(error?.message ?? error), timedOut: false });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, code: -2, stdout, stderr: `${stderr}\n超时（${timeout}ms）`.trim(), timedOut: true });
    }, Math.max(1000, timeout));
    const handle = (chunk, isErr) => {
      const text = chunk.toString("utf8");
      if (isErr) stderr += text;
      else {
        stdout += text;
        if (onLine) {
          for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim(), false);
        }
      }
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    };
    child.stdout?.on("data", (chunk) => handle(chunk, false));
    child.stderr?.on("data", (chunk) => handle(chunk, true));
    child.on("error", (error) => finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut: false }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr, timedOut: false }));
  });
}

export async function probePython(candidate) {
  // 用 | 分隔版本与真实解释器路径：路径常含空格，按空白切分会把路径截断。
  const result = await run(candidate.cmd, [...candidate.prefix, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}')"], { timeout: 8000 });
  if (!result.ok) return null;
  const [version = "", executable = ""] = (result.stdout.trim().split(/\r?\n/).pop() || "").split("|");
  const [major, minor] = version.split(".").map(Number);
  if (!Number.isFinite(major) || major < 3 || (major === 3 && minor < 9)) return null;
  return { ...candidate, version, exePath: executable && fs.existsSync(executable) ? executable : "" };
}

export async function findSystemPython() {
  const candidates = [];
  if (env("RUODAO_PLAZA_PYTHON")) candidates.push({ cmd: env("RUODAO_PLAZA_PYTHON"), prefix: [] });
  if (process.platform === "win32") {
    candidates.push({ cmd: "python", prefix: [] }, { cmd: "py", prefix: ["-3"] }, { cmd: "python3", prefix: [] });
  } else {
    candidates.push({ cmd: "python3", prefix: [] }, { cmd: "python", prefix: [] });
  }
  for (const candidate of candidates) {
    const found = await probePython(candidate);
    if (found) return found;
  }
  return null;
}

export function readEngineState() {
  const saved = readJson(ENGINE_STATE, {}) || {};
  const python = saved.python || VENV_PY;
  const sitePackages = String(saved.sitePackages || "");
  const exists = Boolean(python) && fs.existsSync(python);
  return {
    ready: Boolean(exists && saved.ready === true),
    python,
    sitePackages,
    mode: String(saved.mode || (sitePackages ? "portable" : "venv")),
    version: String(saved.version || ""),
    pythonVersion: String(saved.pythonVersion || ""),
    installedAt: saved.installedAt || null,
    mirror: saved.mirror || "",
  };
}

/** 运行音乐引擎时的附加环境：portable 模式把私有依赖目录注入 PYTHONPATH。 */
export function engineEnv(extra = {}) {
  const engine = readEngineState();
  // 引擎子进程必须继承父进程环境（PATH/HOME/演示用 MOCK_* 等），只额外补 PYTHONPATH。
  const merged = { ...process.env, ...extra };
  if (engine.sitePackages) {
    merged.PYTHONPATH = [engine.sitePackages, merged.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  return merged;
}

export function readInstallState() {
  return readJson(INSTALL_STATE, null);
}

export function installProgress() {
  const state = readInstallState();
  if (!state) return { step: "idle", percent: 0, message: "尚未安装搜索引擎" };
  const engine = readEngineState();
  if (engine.ready) {
    return { ...state, step: "ready", percent: 100, message: state.message || "搜索引擎已就绪", engine };
  }
  const updatedAt = Number(state.updatedAt) || 0;
  const age = Date.now() - updatedAt;
  if (state.step === "running" && age > 10 * 60 * 1000) {
    return { ...state, stale: true, message: `安装进程可能已中断（${Math.round(age / 60000)} 分钟无更新）` };
  }
  return state;
}

export function serverBaseUrl() {
  const saved = readJson(SERVER_JSON, {}) || {};
  const port = Number(saved.port) || Number(env("RUODAO_PLAZA_PORT", "16120")) || 16120;
  return `http://127.0.0.1:${port}`;
}

export async function fetchHealth(base, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/__health`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.service === "music-plaza" ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function fail(message, extra = {}) {
  emit({ state: "failed", error: message, ...extra });
  process.exit(1);
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); }
      catch { resolve({ prompt: data.trim() }); }
    });
    process.stdin.on("error", () => resolve({}));
  });
}
