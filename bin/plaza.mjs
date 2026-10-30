#!/usr/bin/env node
/**
 * Music Plaza plugin host commands.
 *
 * Commands (dispatch by argv[2], payload on stdin as JSON):
 *   doctor | engine_status | engine_install | engine_progress | engine_reset
 *   search | server_ensure | server_stop | setup | engine_install_worker
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  BIN_DIR,
  ENGINE_DIR,
  ENGINE_SITE_DIR,
  ENGINE_STATE,
  HOME,
  INSTALL_LOG,
  INSTALL_STATE,
  PLUGIN_ROOT,
  SERVER_JSON,
  SERVER_LOG,
  SERVER_PID,
  SERVER_SCRIPT,
  VENV_DIR,
  VENV_PY,
  emit,
  engineEnv,
  ensureHome,
  env,
  fail,
  fetchHealth,
  findSystemPython,
  installProgress,
  probePython,
  readEngineState,
  readInstallState,
  readJson,
  readStdin,
  run,
  serverBaseUrl,
  sleep,
  tailFile,
  writeJson,
} from "./shared.mjs";
import { DEFAULT_SOURCE_IDS, SOURCES, parseSources, sourceList } from "./sources.mjs";

const PLUGIN_VERSION = "1.3.0";
const MUSICDL_VERSION = env("RUODAO_PLAZA_MUSICDL_VERSION", "2.14.2");
const DEFAULT_PORT = () => Number(env("RUODAO_PLAZA_PORT", "16120")) || 16120;
const DEFAULT_LIMIT = () => Math.min(Math.max(Number(env("RUODAO_PLAZA_LIMIT", "8")) || 8, 1), 20);
const DEFAULT_TIMEOUT = () => Math.min(Math.max(Number(env("RUODAO_PLAZA_TIMEOUT", "60")) || 60, 10), 180);
const configuredSources = () => parseSources(env("RUODAO_PLAZA_SOURCES", DEFAULT_SOURCE_IDS.join(",")));

function appendLog(line) {
  try {
    fs.appendFileSync(INSTALL_LOG, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* best effort */ }
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

async function resolveEngineDeep() {
  const state = readEngineState();
  if (state.ready && state.version) return state;
  if (!fs.existsSync(state.python)) return state;
  const result = await run(state.python, ["-c", "import musicdl; print(getattr(musicdl, '__version__', ''))"], { timeout: 30000, env: engineEnv() });
  if (!result.ok) {
    if (state.ready) return { ...state, ready: false, error: (result.stderr || "musicdl 导入失败").slice(-800) };
    return state;
  }
  const version = result.stdout.trim().split(/\s+/).pop() || "";
  if (!version) return state.ready ? state : { ...state, ready: false };
  // 保留 portable 模式的 sitePackages/mode：丢掉它们会让下次启动不再注入依赖目录。
  const next = {
    ready: true,
    python: state.python || VENV_PY,
    sitePackages: state.sitePackages || "",
    mode: state.mode || (state.sitePackages ? "portable" : "venv"),
    version,
    pythonVersion: state.pythonVersion || "",
    installedAt: new Date().toISOString(),
    mirror: state.mirror || "",
  };
  try { ensureHome(); writeJson(ENGINE_STATE, next); } catch { /* ignore */ }
  return next;
}

function readServerState() {
  const saved = readJson(SERVER_JSON, {}) || {};
  const pid = readJson(SERVER_PID, {}) || {};
  return { ...saved, ...pid, port: Number(saved.port || pid.port || 0) || null };
}

async function engineStatusPayload(deep = false) {
  ensureHome();
  const engine = deep ? await resolveEngineDeep() : readEngineState();
  const systemPython = await findSystemPython();
  const install = installProgress();
  const actualBase = serverBaseUrl();
  const health = await fetchHealth(actualBase);
  return {
    engine: {
      ...engine,
      venvExists: fs.existsSync(VENV_DIR),
      venvPython: VENV_PY,
      home: HOME,
      install,
      systemPython: systemPython ? { cmd: systemPython.cmd, version: systemPython.version } : null,
    },
    server: health
      ? { reachable: true, baseUrl: actualBase, port: health.port || new URL(actualBase).port, health }
      : { reachable: false, baseUrl: actualBase, port: Number(new URL(actualBase).port) },
    defaultSources: configuredSources(),
    sources: sourceList(),
  };
}

/* ---------------- install worker ---------------- */

async function engineInstallWorker(onProgress) {
  ensureHome();
  const startedAt = Date.now();
  const workerPid = process.pid;
  let lastLine = "";
  let percent = 2;
  const state = (patch = {}) => {
    const payload = {
      step: "running",
      percent,
      message: lastLine,
      startedAt,
      updatedAt: Date.now(),
      workerPid,
      musicdlVersion: MUSICDL_VERSION,
      home: HOME,
      log: INSTALL_LOG,
      ...patch,
    };
    writeJson(INSTALL_STATE, payload);
    return payload;
  };
  const step = (message, nextPercent) => {
    percent = nextPercent;
    lastLine = message;
    state({ message });
    appendLog(message);
    try { onProgress?.({ status: "running", percent, message }); } catch { /* ignore */ }
  };
  const finishFailed = (error) => {
    const text = String(error);
    appendLog(`FAILED: ${text}`);
    writeJson(INSTALL_STATE, {
      step: "failed",
      percent: 0,
      message: "搜索引擎安装失败",
      error: text.slice(-1200),
      startedAt,
      updatedAt: Date.now(),
      logTail: tailFile(INSTALL_LOG, 60),
    });
    try { onProgress?.({ status: "failed", percent: 0, message: text.slice(-600) }); } catch { /* ignore */ }
  };

  try {
    fs.writeFileSync(INSTALL_LOG, "", "utf8");
    appendLog(`plugin=${PLUGIN_VERSION} musicdl=${MUSICDL_VERSION} home=${HOME}`);
    step("正在查找 Python 3.9+…", 3);
    const python = await findSystemPython();
    if (!python) {
      finishFailed("未找到 Python 3.9+。请先安装 Python（python.org/downloads，安装时勾选 Add Python to PATH），再点击重试。");
      return;
    }
    const pythonExe = python.exePath || python.cmd;
    state({ python: pythonExe, pythonVersion: python.version });

    step(`正在准备独立运行环境（Python ${python.version}）…`, 8);
    let venvOk = false;
    let venvNote = "";
    try {
      const venvResult = await run(python.cmd, [...python.prefix, "-m", "venv", VENV_DIR], { timeout: 240000, onLine: (line) => appendLog(line) });
      venvOk = venvResult.ok && fs.existsSync(VENV_PY);
      if (!venvOk) venvNote = (venvResult.stderr || venvResult.stdout || "").slice(-500);
    } catch (error) {
      venvNote = String(error?.message || error);
    }
    if (!venvOk) {
      // Windows 随包 Python 是 embeddable 发行版（没有 venv 模块）：改走私有依赖目录，
      // pip --target 到 ~/.ruodao/music-plaza/engine/site-packages，运行时自动注入路径。
      appendLog(`venv 不可用，改用 portable 依赖目录：${venvNote}`);
      step("当前 Python 不支持 venv，改用独立依赖目录安装…", 12);
      const pipCheck = await run(python.cmd, [...python.prefix, "-m", "pip", "--version"], { timeout: 90000 });
      if (!pipCheck.ok) {
        finishFailed(`当前 Python 没有可用的 pip：${((pipCheck.stderr || pipCheck.stdout || "").slice(-500) || "pip 不可用")}。请安装完整版 Python 3.9+（python.org，勾选 Add Python to PATH），或在若道「开发工具」安装 Python 后重试。`);
        return;
      }
      try { fs.mkdirSync(ENGINE_SITE_DIR, { recursive: true }); } catch { /* 交给 pip 报错 */ }
      try { fs.rmSync(VENV_DIR, { recursive: true, force: true }); } catch { /* 残留目录 */ }
    }

    const installPython = venvOk ? VENV_PY : pythonExe;
    const customMirror = env("RUODAO_PLAZA_PIP_MIRROR");
    const mirrors = [];
    if (customMirror && !/^(none|official|off)$/i.test(customMirror)) mirrors.push(customMirror);
    for (const mirror of ["https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.aliyun.com/pypi/simple", "https://pypi.org/simple"]) {
      if (!mirrors.includes(mirror)) mirrors.push(mirror);
    }
    if (/^(none|official|off)$/i.test(customMirror)) mirrors.splice(0, mirrors.length, "https://pypi.org/simple");

    let installed = false;
    let lastError = "";
    for (const mirror of mirrors) {
      step(`正在从 ${mirror.replace(/^https?:\/\//, "").replace(/\/simple.*$/, "")} 安装 musicdl（首次约 100-200MB）…`, 18);
      appendLog(`pip install via ${mirror}`);
      let downloaded = 0;
      const pipArgs = [
        "-m", "pip", "install",
        "--disable-pip-version-check",
        "--no-input",
        "--upgrade",
      ];
      if (!venvOk) pipArgs.push("--target", ENGINE_SITE_DIR);
      pipArgs.push(`musicdl==${MUSICDL_VERSION}`, "-i", mirror);
      const pip = await run(installPython, pipArgs, {
        timeout: 20 * 60 * 1000,
        onLine: (line) => {
          appendLog(line);
          if (/^Downloading\b/i.test(line) || /^\s+Downloading\b/i.test(line)) {
            downloaded += 1;
            percent = Math.min(82, 22 + downloaded * 2);
            lastLine = `下载依赖中（${downloaded} 个包）…`;
            state({ message: lastLine });
          } else if (/^Installing collected packages/i.test(line)) {
            percent = 86;
            lastLine = "正在安装依赖包…";
            state({ message: lastLine });
          } else if (/^Successfully installed/i.test(line)) {
            percent = 92;
            lastLine = "依赖安装完成，正在校验…";
            state({ message: lastLine });
          }
        },
      });
      if (pip.ok) {
        installed = true;
        break;
      }
      lastError = (pip.stderr || pip.stdout || "").slice(-1000) || `pip 退出码 ${pip.code}`;
      appendLog(`mirror failed: ${mirror}\n${lastError}`);
      step(`镜像安装失败，尝试下一个源…`, 20);
    }
    if (!installed) {
      finishFailed(`musicdl 安装失败：${lastError}`);
      return;
    }

    step("正在校验 musicdl 引擎…", 94);
    if (!venvOk) {
      const pthNote = ensurePortablePth(pythonExe, ENGINE_SITE_DIR);
      if (pthNote) appendLog(pthNote);
    }
    const verify = await run(installPython, ["-c", "import musicdl; print(getattr(musicdl, '__version__', ''))"], { timeout: 60000, env: engineEnv() });
    if (!verify.ok) {
      finishFailed(`musicdl 校验失败：${(verify.stderr || verify.stdout || "").slice(-800)}`);
      return;
    }
    const version = verify.stdout.trim().split(/\s+/).pop() || MUSICDL_VERSION;
    writeJson(ENGINE_STATE, {
      ready: true,
      python: installPython,
      sitePackages: venvOk ? "" : ENGINE_SITE_DIR,
      mode: venvOk ? "venv" : "portable",
      version,
      pythonVersion: python.version,
      installedAt: new Date().toISOString(),
      mirror: mirrors[0] || "",
    });
    writeJson(INSTALL_STATE, {
      step: "ready",
      percent: 100,
      message: `搜索引擎已就绪（musicdl ${version}）`,
      version,
      startedAt,
      updatedAt: Date.now(),
      log: INSTALL_LOG,
    });
    appendLog(`ready: musicdl ${version} (${venvOk ? "venv" : "portable"})`);
    try { onProgress?.({ status: "ok", percent: 100, message: `搜索引擎已就绪（musicdl ${version}）` }); } catch { /* ignore */ }
  } catch (error) {
    finishFailed(String(error?.stack || error?.message || error));
  }
}

/** embeddable Python 的 _pth 是隔离模式：PYTHONPATH 会被忽略，私有依赖目录必须写进 _pth。 */
function ensurePortablePth(pythonExe, siteDir) {
  try {
    const dir = path.dirname(pythonExe);
    const entry = fs.readdirSync(dir).find((name) => /^python\d+\._pth$/i.test(name));
    if (!entry) return "";
    const file = path.join(dir, entry);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.includes(siteDir)) return "";
    fs.writeFileSync(file, `${raw.trimEnd()}\n${siteDir}\n`, "utf8");
    return `已把依赖目录写入 ${entry}`;
  } catch (error) {
    return `警告：写入 _pth 失败（${error?.message || error}），引擎可能无法导入 musicdl`;
  }
}

/* ---------------- commands ---------------- */

async function cmdDoctor() {
  ensureHome();
  const payload = await engineStatusPayload(true);
  emit({
    state: "succeeded",
    ok: Boolean(payload.engine.ready || payload.engine.install?.step === "running"),
    plugin: { version: PLUGIN_VERSION, root: PLUGIN_ROOT, musicdlVersion: MUSICDL_VERSION },
    ...payload,
    checks: {
      python: Boolean(payload.engine.systemPython || payload.engine.venvExists),
      engine: Boolean(payload.engine.ready),
      server: Boolean(payload.server.reachable),
    },
  });
}

async function cmdEngineStatus() {
  const payload = await engineStatusPayload(true);
  emit({
    state: "succeeded",
    ready: Boolean(payload.engine.ready),
    installing: payload.engine.install?.step === "running" && !payload.engine.install?.stale,
    version: payload.engine.version,
    ...payload,
  });
}

async function cmdEngineInstall() {
  ensureHome();
  const engine = readEngineState();
  if (engine.ready) {
    const deep = await resolveEngineDeep();
    if (deep.ready) {
      emit({ state: "succeeded", started: false, alreadyReady: true, engine: deep, install: installProgress() });
      return;
    }
  }
  const current = readInstallState();
  const fresh = current?.step === "running" && Date.now() - Number(current.updatedAt || 0) < 10 * 60 * 1000;
  if (fresh && (!current.workerPid || pidAlive(current.workerPid))) {
    emit({ state: "succeeded", started: false, alreadyRunning: true, install: installProgress() });
    return;
  }
  fs.mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [path.join(BIN_DIR, "plaza.mjs"), "engine_install_worker"], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      RUODAO_PLAZA_HOME: HOME,
      RUODAO_PLAZA_PIP_MIRROR: env("RUODAO_PLAZA_PIP_MIRROR"),
    },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  writeJson(INSTALL_STATE, {
    step: "running",
    percent: 1,
    message: "安装任务已启动…",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    workerPid: child.pid,
    log: INSTALL_LOG,
  });
  emit({ state: "succeeded", started: true, workerPid: child.pid, install: installProgress() });
}

async function cmdEngineProgress() {
  const install = installProgress();
  emit({
    state: "succeeded",
    ...install,
    engine: readEngineState(),
    logTail: tailFile(INSTALL_LOG, 30),
  });
}

async function cmdEngineReset() {
  await cmdServerStop(true);
  for (const target of [ENGINE_DIR, INSTALL_STATE, ENGINE_STATE, INSTALL_LOG]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  emit({ state: "succeeded", message: "搜索引擎已重置，可重新一键安装" });
}

function buildEngineCommand({ keywords, sources, limit, timeout }) {
  const concurrency = Math.min(Math.max(Number(env("RUODAO_PLAZA_CONCURRENCY", "8")) || 8, 1), 24);
  const engineArgs = [
    "--keyword", keywords,
    "--sources", sources.join(","),
    "--limit", String(limit),
    "--timeout", String(timeout),
    "--concurrency", String(concurrency),
  ];
  const override = env("RUODAO_PLAZA_ENGINE_CMD");
  if (override) {
    if (override.startsWith("[")) {
      try {
        const parsed = JSON.parse(override);
        if (Array.isArray(parsed) && parsed.length) {
          return { cmd: String(parsed[0]), args: [...parsed.slice(1).map(String), ...engineArgs], shell: false };
        }
      } catch { /* fall through to shell mode */ }
    }
    return { cmd: override, args: engineArgs, shell: true };
  }
  const engine = readEngineState();
  if (!engine.ready) return { error: "NEEDS_ENGINE" };
  return { cmd: engine.python, args: [path.join(PLUGIN_ROOT, "python", "musicdl_search.py"), ...engineArgs], shell: false };
}

async function cmdSearch(payload) {
  const keywords = String(payload.keywords ?? payload.keyword ?? payload.prompt ?? "").trim();
  if (!keywords) fail("缺少搜索关键词：请传 { keywords }");
  const sources = parseSources(payload.sources ?? env("RUODAO_PLAZA_SOURCES", DEFAULT_SOURCE_IDS.join(",")));
  const limit = Math.min(Math.max(Number(payload.limit) || DEFAULT_LIMIT(), 1), 20);
  const timeoutSec = Math.min(Math.max(Number(payload.timeoutSec) || DEFAULT_TIMEOUT(), 10), 180);
  const command = buildEngineCommand({ keywords, sources, limit, timeout: timeoutSec });
  if (command.error === "NEEDS_ENGINE") fail("搜索引擎尚未安装：请先执行 engine_install 或打开音乐广场点击一键安装", { needsEngine: true });

  const songs = [];
  const errors = [];
  let timedOut = [];
  let finalEvent = null;
  const stderrChunks = [];
  const child = spawn(command.cmd, command.args, {
    cwd: PLUGIN_ROOT,
    // portable 模式（随包 embeddable Python）依赖目录通过 PYTHONPATH 注入。
    env: engineEnv({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }),
    windowsHide: true,
    shell: command.shell,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) errors.push({ source: "engine", message: error });
    emit({
      state: "succeeded",
      keywords,
      sources: sourceList().filter((entry) => sources.includes(entry.id)),
      total: songs.length,
      songs,
      errors,
      timedOutSources: timedOut,
      engine: command.shell ? "override" : "musicdl",
    });
  };
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
    finish(`搜索超时（${timeoutSec + 15} 秒）`);
  }, (timeoutSec + 15) * 1000);

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "source") {
        for (const song of event.songs || []) {
          if (!song?.url) continue;
          songs.push({ ...song, source: event.source, sourceName: SOURCES[event.source]?.name || event.source, directUrl: song.url });
        }
        if (!event.ok) errors.push({ source: event.source, message: event.error || "搜索失败" });
      } else if (event.type === "done") {
        finalEvent = event;
        timedOut = event.timedOut || [];
        finish("");
      } else if (event.type === "error") {
        finish(event.message || "搜索引擎返回错误");
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
    if (stderrChunks.join("").length > 8000) stderrChunks.splice(0, stderrChunks.length - 20);
  });
  child.on("error", (error) => finish(`无法启动搜索引擎：${error.message}`));
  child.on("close", () => {
    if (!settled) finish(stderrChunks.join("").trim().slice(-800) || "搜索引擎提前退出");
  });
}

async function startServer() {
  ensureHome();
  const configured = DEFAULT_PORT();
  const saved = readServerState();
  const ports = [];
  if (saved.port) ports.push(Number(saved.port));
  for (let offset = 0; offset < 10; offset += 1) ports.push(configured + offset);
  const tried = new Set();
  let lastError = "";
  for (const port of ports) {
    if (tried.has(port)) continue;
    tried.add(port);
    const base = `http://127.0.0.1:${port}`;
    const health = await fetchHealth(base);
    if (health) {
      writeJson(SERVER_JSON, { port, baseUrl: base, updatedAt: new Date().toISOString(), pid: health.pid });
      return { started: false, baseUrl: base, port, health };
    }
    const stalePid = Number(saved.pid) || 0;
    if (stalePid && Number(saved.port) === port && pidAlive(stalePid)) {
      try { process.kill(stalePid); } catch { /* ignore */ }
      for (let i = 0; i < 20; i += 1) {
        await sleep(100);
        if (!pidAlive(stalePid)) break;
      }
    }
    if (await portHasListener(port)) {
      lastError = `端口 ${port} 已被其他程序占用`;
      continue;
    }
    let logFd = null;
    try {
      logFd = fs.openSync(SERVER_LOG, "a");
      const child = spawn(process.execPath, [SERVER_SCRIPT], {
        cwd: PLUGIN_ROOT,
        env: {
          ...process.env,
          RUODAO_PLAZA_HOME: HOME,
          RUODAO_PLAZA_PORT: String(port),
        },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
    } catch (error) {
      lastError = `启动本地服务失败：${error?.message || error}`;
      continue;
    } finally {
      if (logFd !== null) {
        try { fs.closeSync(logFd); } catch { /* ignore */ }
      }
    }
    for (let i = 0; i < 40; i += 1) {
      await sleep(300);
      const ready = await fetchHealth(base);
      if (ready) {
        writeJson(SERVER_JSON, { port, baseUrl: base, updatedAt: new Date().toISOString(), pid: ready.pid });
        return { started: true, baseUrl: base, port, health: ready };
      }
    }
    lastError = `本地服务启动后未就绪，日志：${tailFile(SERVER_LOG, 8)}`;
  }
  throw new Error(lastError || "无法启动本地播放服务");
}

async function cmdServerEnsure() {
  try {
    const result = await startServer();
    emit({ state: "succeeded", ...result });
  } catch (error) {
    fail(String(error?.message || error));
  }
}

function portHasListener(port) {
  return new Promise((resolve) => {
    import("node:net").then(({ connect }) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(600, () => { socket.destroy(); resolve(false); });
    }).catch(() => resolve(false));
  });
}

/* ---------------- setup (post-install self check) ---------------- */

const SETUP_WAIT_MS = 30 * 60 * 1000;

async function cmdSetup() {
  ensureHome();
  const startedAt = Date.now();
  const order = [];
  const components = new Map();
  // NDJSON：桌面端按行读取「setup」事件展示每个组件的检查/安装结果，
  // 环境差异（有没有 Python、venv 能不能用、端口是否被占）都要能看见。
  const report = (id, name, patch) => {
    const current = components.get(id) || { id, name, status: "pending", detail: "", percent: 0 };
    const next = { ...current, ...patch, id, name: patch.name || current.name };
    if (!components.has(id)) order.push(id);
    components.set(id, next);
    emit({ type: "setup", component: next });
  };
  const snapshot = () => order.map((id) => components.get(id));

  try {
    report("python", "Python 运行环境", { status: "running", detail: "正在检查 Python 3.9+…", percent: 10 });
    const python = await findSystemPython();
    if (python) {
      report("python", "Python 运行环境", {
        status: "ok",
        detail: `Python ${python.version} · ${python.exePath || python.cmd}`,
        percent: 100,
      });
    } else {
      report("python", "Python 运行环境", {
        status: "failed",
        detail: "未找到 Python 3.9+。可在若道「开发工具 → Python」一键安装，或从 python.org 安装（勾选 Add Python to PATH）后重新自检。",
        percent: 100,
      });
    }

    report("engine", "musicdl 搜索内核", { status: "running", detail: "正在检查 musicdl…", percent: 0 });
    let engine = await resolveEngineDeep();
    if (!engine.ready && python) {
      const current = installProgress();
      const installing = current.step === "running" && !current.stale && (!current.workerPid || pidAlive(current.workerPid));
      if (installing) {
        report("engine", "musicdl 搜索内核", { status: "running", detail: current.message || "已有安装任务进行中，正在等待…", percent: Number(current.percent) || 1 });
      } else {
        report("engine", "musicdl 搜索内核", { status: "running", detail: "正在安装 musicdl（首次约 100-200MB）…", percent: 2 });
        await engineInstallWorker((progress) => {
          report("engine", "musicdl 搜索内核", {
            status: progress.status === "ok" ? "ok" : progress.status === "failed" ? "failed" : "running",
            detail: progress.message || "",
            percent: Number(progress.percent) || 0,
          });
        });
        engine = await resolveEngineDeep();
      }
      const deadline = Date.now() + SETUP_WAIT_MS;
      while (!engine.ready && Date.now() < deadline) {
        const current = installProgress();
        if (current.step !== "running" || current.stale) break;
        report("engine", "musicdl 搜索内核", { status: "running", detail: current.message || "正在安装…", percent: Number(current.percent) || 1 });
        await sleep(2000);
        engine = await resolveEngineDeep();
      }
    }
    if (engine.ready) {
      report("engine", "musicdl 搜索内核", {
        status: "ok",
        detail: `musicdl ${engine.version}${engine.mode === "portable" ? "（独立依赖目录）" : "（独立环境）"}`,
        percent: 100,
        version: engine.version,
      });
    } else if (!python) {
      report("engine", "musicdl 搜索内核", { status: "blocked", detail: "缺少 Python，已跳过内核安装；装好 Python 后重新自检即可", percent: 100 });
    } else {
      const install = installProgress();
      report("engine", "musicdl 搜索内核", {
        status: "failed",
        detail: install.error ? String(install.error).slice(-400) : (install.message || "引擎未就绪"),
        percent: 100,
      });
    }

    report("server", "本地播放代理", { status: "running", detail: "正在启动本地服务…", percent: 30 });
    try {
      const server = await startServer();
      report("server", "本地播放代理", {
        status: "ok",
        detail: `${server.baseUrl}${server.started ? "（已启动）" : "（已在运行）"}`,
        percent: 100,
      });
    } catch (error) {
      report("server", "本地播放代理", { status: "failed", detail: String(error?.message || error).slice(-400), percent: 100 });
    }
  } catch (error) {
    const text = String(error?.stack || error?.message || error);
    for (const id of ["python", "engine", "server"]) {
      if (!components.has(id)) report(id, id, { status: "failed", detail: text.slice(-400), percent: 100 });
    }
  } finally {
    const list = snapshot();
    emit({
      type: "setup-result",
      ok: list.length > 0 && list.every((entry) => entry.status === "ok"),
      home: HOME,
      components: list,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

async function cmdServerStop(silent = false) {
  const saved = readServerState();
  const base = saved.port ? `http://127.0.0.1:${saved.port}` : serverBaseUrl();
  const health = await fetchHealth(base);
  let stopped = false;
  if (health && saved.pid && pidAlive(saved.pid)) {
    try {
      process.kill(saved.pid);
      stopped = true;
    } catch { /* ignore */ }
    for (let i = 0; i < 20; i += 1) {
      await sleep(100);
      if (!pidAlive(saved.pid)) break;
    }
  }
  try { fs.rmSync(SERVER_PID, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(SERVER_JSON, { force: true }); } catch { /* ignore */ }
  if (!silent) emit({ state: "succeeded", stopped, message: stopped ? "本地播放服务已停止" : "本地播放服务未在运行" });
}

/* ---------------- dispatch ---------------- */

const mode = process.argv[2] || "doctor";
const isWorker = mode === "engine_install_worker";
if (isWorker) {
  await engineInstallWorker();
} else {
  const payload = await readStdin();
  switch (mode) {
    case "doctor":
      await cmdDoctor();
      break;
    case "engine_status":
      await cmdEngineStatus();
      break;
    case "engine_install":
      await cmdEngineInstall();
      break;
    case "engine_progress":
      await cmdEngineProgress();
      break;
    case "engine_reset":
      await cmdEngineReset();
      break;
    case "search":
      await cmdSearch(payload);
      break;
    case "server_ensure":
      await cmdServerEnsure();
      break;
    case "server_stop":
      await cmdServerStop();
      break;
    case "setup":
      await cmdSetup();
      break;
    default:
      fail(`未知命令：${mode}`);
  }
}
