#!/usr/bin/env node
/**
 * Music Plaza local service (127.0.0.1 only).
 *
 * Responsibilities:
 *   - Progressive aggregated search: spawns the musicdl bridge and relays
 *     per-source NDJSON results to the UI as NDJSON.
 *   - Audio proxy: rewrites playable direct URLs behind opaque ids, adding the
 *     Referer / UA / Cookie headers required by each provider and passing
 *     Range requests through so seeking works.
 *   - Cover and LRC proxy with small in-memory caches.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  HOME,
  PLUGIN_ROOT,
  SERVER_PID,
  engineEnv,
  ensureHome,
  env,
  readEngineState,
  readJson,
  writeJson,
} from "./shared.mjs";
import {
  DEFAULT_SOURCE_IDS,
  MAX_SOURCES_PER_SEARCH,
  SOURCES,
  capSources,
  catalogPayload,
  mimeForExt,
  parseSources,
  sourceList,
} from "./sources.mjs";
import { kugouRankList, kugouRankSongs } from "./ranks.mjs";

const VERSION = "1.3.0";
const HOST = "127.0.0.1";
const PORT = Number(env("RUODAO_PLAZA_PORT", "16120")) || 16120;
const PY_SCRIPT = path.join(PLUGIN_ROOT, "python", "musicdl_search.py");
const SEARCH_TTL = 10 * 60 * 1000;
const PLAYLIST_TTL = 15 * 60 * 1000;
const PLAYLIST_TIMEOUT = 90;
const ENTRY_TTL = 90 * 60 * 1000;
const MAX_ENTRIES = 6000;
const MAX_EPISODES = 24;
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const MAX_COVER_BYTES = 8 * 1024 * 1024;

const entries = new Map();
const searches = new Map();
const playlists = new Map();
const coverCache = new Map();
const activeChildren = new Set();

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);
const defaultLimit = () => clamp(env("RUODAO_PLAZA_LIMIT", "8"), 1, 20);
const defaultTimeout = () => clamp(env("RUODAO_PLAZA_TIMEOUT", "60"), 10, 180);
const defaultConcurrency = () => clamp(env("RUODAO_PLAZA_CONCURRENCY", "8"), 1, 24);
const defaultSources = () => parseSources(env("RUODAO_PLAZA_SOURCES", DEFAULT_SOURCE_IDS.join(",")));

function log(message) {
  try {
    process.stderr.write(`[music-plaza] ${new Date().toISOString()} ${message}\n`);
  } catch { /* ignore */ }
}

function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  if (origin) res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Music-Plaza");
}

function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function guessExt(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function fmtDuration(sec) {
  const value = Number(sec) || 0;
  if (!value) return "";
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(Math.round(value % 60)).padStart(2, "0")}`;
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return "";
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function safeFilename(entry) {
  const base = `${entry.singer ? `${entry.singer} - ` : ""}${entry.name}`.replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, " ").trim();
  const trimmed = base.slice(0, 90) || "music";
  return `${trimmed}.${entry.ext || "mp3"}`;
}

function contentDisposition(filename, inline = false) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sanitizeHeaders(raw) {
  const output = {};
  if (!raw || typeof raw !== "object") return output;
  const blocked = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "accept-encoding", "range"]);
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (blocked.has(key.toLowerCase())) continue;
    output[key] = String(value);
  }
  return output;
}

function trimEntries() {
  if (entries.size <= MAX_ENTRIES) return;
  const oldest = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, entries.size - MAX_ENTRIES);
  for (const item of oldest) entries.delete(item.id);
}

function registerSong(raw, sourceId) {
  const name = String(raw?.name || "").trim();
  if (!name) return null;
  const episodes = Array.isArray(raw?.episodes) ? raw.episodes : [];
  if (raw?.kind === "collection" || episodes.length) return registerCollection(raw, sourceId, episodes);

  const url = String(raw?.url || "");
  if (!/^https?:\/\//i.test(url)) return null;
  let ext = String(raw.ext || "").toLowerCase().replace(/^\./, "");
  if (!ext || ext === "m3u8") ext = guessExt(url) || "mp3";
  if (ext === "m3u8") return null;
  const id = `${sourceId}-${crypto.createHash("sha1").update(`${url}|${name}|${raw.singer || ""}`).digest("hex").slice(0, 16)}`;
  const entry = {
    id,
    kind: "song",
    source: sourceId,
    sourceName: SOURCES[sourceId]?.name || sourceId,
    referer: SOURCES[sourceId]?.referer || "",
    url,
    headers: sanitizeHeaders(raw.headers),
    cookies: raw.cookies && typeof raw.cookies === "object" ? raw.cookies : {},
    ext,
    lyric: String(raw.lyric || ""),
    lyricText: "",
    cover: String(raw.cover || ""),
    name,
    singer: String(raw.singer || ""),
    createdAt: Date.now(),
  };
  entries.set(id, entry);
  trimEntries();
  return {
    id,
    kind: "song",
    source: sourceId,
    sourceName: entry.sourceName,
    name,
    singer: entry.singer,
    album: String(raw.album || ""),
    duration: String(raw.duration || "") || fmtDuration(raw.durationSec),
    durationSec: Number(raw.durationSec) || 0,
    ext,
    size: String(raw.size || "") || fmtBytes(raw.sizeBytes),
    cover: entry.cover ? `/api/cover/${id}` : "",
    streamUrl: `/api/audio/${id}`,
    lyricUrl: `/api/lyric/${id}`,
    downloadUrl: `/api/download/${id}`,
    hasLyric: Boolean(entry.lyric),
  };
}

/** 有声书 / 播客：一本书 = collection，章节是真正可播放的子项。 */
function registerCollection(raw, sourceId, rawEpisodes) {
  const name = String(raw?.name || "").trim();
  if (!name) return null;
  const children = [];
  for (const episode of rawEpisodes.slice(0, MAX_EPISODES)) {
    const child = registerSong({ ...episode, episodes: undefined, kind: "song" }, sourceId);
    if (child) children.push(child);
  }
  if (!children.length) return null;
  const id = `${sourceId}-c-${crypto.createHash("sha1").update(`${name}|${raw.singer || ""}|${sourceId}`).digest("hex").slice(0, 16)}`;
  const cover = String(raw.cover || "");
  entries.set(id, {
    id,
    kind: "collection",
    source: sourceId,
    sourceName: SOURCES[sourceId]?.name || sourceId,
    referer: SOURCES[sourceId]?.referer || "",
    url: "",
    headers: {},
    cookies: {},
    ext: "",
    lyric: "",
    lyricText: "",
    cover,
    name,
    singer: String(raw.singer || ""),
    createdAt: Date.now(),
  });
  trimEntries();
  return {
    id,
    kind: "collection",
    source: sourceId,
    sourceName: SOURCES[sourceId]?.name || sourceId,
    name,
    singer: String(raw.singer || ""),
    album: String(raw.album || ""),
    duration: "",
    durationSec: 0,
    ext: "",
    size: "",
    cover: cover ? `/api/cover/${id}` : "",
    streamUrl: "",
    lyricUrl: "",
    downloadUrl: "",
    hasLyric: false,
    episodeTotal: Number(raw.episodeTotal) || children.length,
    episodeTruncated: Boolean(raw.episodeTruncated),
    episodes: children,
  };
}

function normalizeSourceResult(event) {
  const songs = [];
  const seen = new Set();
  for (const raw of event.songs || []) {
    const song = registerSong(raw, event.source);
    if (!song) continue;
    const key = `${song.name.toLowerCase()}|${song.singer.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    songs.push(song);
  }
  return { songs, ok: Boolean(event.ok), error: event.error || "", elapsedMs: Number(event.elapsedMs) || 0 };
}

function engineInfo() {
  const engine = readEngineState();
  return { ready: engine.ready, version: engine.version, python: engine.python, mode: engine.mode, home: HOME };
}

function engineCommandPrefix() {
  const override = env("RUODAO_PLAZA_ENGINE_CMD");
  if (override) {
    if (override.startsWith("[")) {
      try {
        const parsed = JSON.parse(override);
        if (Array.isArray(parsed) && parsed.length) {
          return { cmd: String(parsed[0]), baseArgs: parsed.slice(1).map(String), shell: false };
        }
      } catch { /* fall through */ }
    }
    return { cmd: override, baseArgs: [], shell: true };
  }
  const engine = readEngineState();
  if (!engine.ready) return { error: "NEEDS_ENGINE" };
  return { cmd: engine.python, baseArgs: [PY_SCRIPT], shell: false };
}

function buildEngineCommand(keyword, sources, limit, timeoutSec) {
  const prefix = engineCommandPrefix();
  if (prefix.error) return prefix;
  const args = [
    ...prefix.baseArgs,
    "--keyword", keyword,
    "--sources", sources.join(","),
    "--limit", String(limit),
    "--timeout", String(timeoutSec),
    "--concurrency", String(defaultConcurrency()),
  ];
  return { cmd: prefix.cmd, args, shell: prefix.shell };
}

function buildPlaylistCommand(url, timeoutSec) {
  const prefix = engineCommandPrefix();
  if (prefix.error) return prefix;
  const args = [...prefix.baseArgs, "--playlist-url", url, "--timeout", String(timeoutSec)];
  return { cmd: prefix.cmd, args, shell: prefix.shell };
}

function searchKey(keyword, sources, limit) {
  return `${keyword.toLowerCase()}|${[...sources].sort().join(",")}|${limit}`;
}

function getSearch(keyword, sources, limit, timeoutSec, refresh = false) {
  const key = searchKey(keyword, sources, limit);
  const existing = searches.get(key);
  if (existing && !refresh) {
    if (!existing.done) return existing;
    if (existing.errorCode === "NEEDS_ENGINE") {
      searches.delete(key);
    } else if (Date.now() - existing.createdAt < SEARCH_TTL) {
      return existing;
    } else {
      searches.delete(key);
    }
  } else if (existing) {
    if (existing.proc) {
      finishSearch(existing, "已被新的搜索请求替代", "SEARCH_REPLACED");
      try { existing.proc.kill(); } catch { /* ignore */ }
    }
    searches.delete(key);
  }
  const state = {
    key,
    keyword,
    sources,
    limit,
    timeoutSec,
    createdAt: Date.now(),
    done: false,
    results: new Map(),
    clients: new Set(),
    waiters: new Set(),
    error: "",
    errorCode: "",
    stderr: "",
    buffer: "",
    proc: null,
    timer: null,
  };
  searches.set(key, state);
  startSearch(state);
  return state;
}

function broadcast(state, event) {
  for (const client of [...state.clients]) {
    try { client.send(event); } catch { /* client gone */ }
  }
}

function finishSearch(state, error = "", errorCode = "") {
  if (state.done) return;
  state.done = true;
  state.finishedAt = Date.now();
  if (error) {
    state.error = error;
    state.errorCode = errorCode;
    broadcast(state, { type: "error", code: errorCode, message: error });
  }
  const total = [...state.results.values()].reduce((sum, item) => sum + item.songs.length, 0);
  const doneEvent = {
    type: "done",
    total,
    sources: state.sources.map((id) => ({
      id,
      name: SOURCES[id]?.name || id,
      count: state.results.get(id)?.songs.length || 0,
      ok: state.results.get(id)?.ok ?? false,
      elapsedMs: state.results.get(id)?.elapsedMs || 0,
      error: state.results.get(id)?.error || "",
    })),
    errors: [...state.results.entries()].filter(([, value]) => !value.ok).map(([id, value]) => ({ source: id, message: value.error })),
    timedOut: state.timedOut || [],
  };
  for (const client of [...state.clients]) {
    try { client.end(doneEvent); } catch { /* ignore */ }
  }
  state.clients.clear();
  for (const resolve of [...state.waiters]) {
    try { resolve(); } catch { /* ignore */ }
  }
  state.waiters.clear();
}

function startSearch(state) {
  const command = buildEngineCommand(state.keyword, state.sources, state.limit, state.timeoutSec);
  if (command.error === "NEEDS_ENGINE") {
    finishSearch(state, "搜索引擎尚未安装，请先点击「一键安装搜索引擎」", "NEEDS_ENGINE");
    return;
  }
  let child;
  try {
    child = spawn(command.cmd, command.args, {
      cwd: PLUGIN_ROOT,
      // portable 模式（随包 embeddable Python）依赖目录通过 PYTHONPATH 注入。
      env: engineEnv({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }),
      windowsHide: true,
      shell: command.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    finishSearch(state, `无法启动搜索引擎：${error?.message || error}`, "ENGINE_SPAWN_FAILED");
    return;
  }
  state.proc = child;
  activeChildren.add(child);
  state.timer = setTimeout(() => {
    state.timedOut = state.sources.filter((id) => !state.results.has(id));
    try { child.kill(); } catch { /* ignore */ }
    finishSearch(state, `搜索超时（${state.timeoutSec} 秒）`, "SEARCH_TIMEOUT");
  }, (state.timeoutSec + 12) * 1000);

  const handleLine = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "source") {
      const result = normalizeSourceResult(event);
      state.results.set(event.source, result);
      broadcast(state, {
        type: "source",
        source: event.source,
        name: SOURCES[event.source]?.name || event.source,
        ...result,
      });
    } else if (event.type === "done") {
      state.timedOut = event.timedOut || [];
      for (const sourceId of state.timedOut) {
        if (state.results.has(sourceId)) continue;
        state.results.set(sourceId, { songs: [], ok: false, error: "超时，可换用其他音源", elapsedMs: 0 });
      }
      finishSearch(state);
    } else if (event.type === "error") {
      finishSearch(state, event.message || "搜索引擎返回错误", "ENGINE_ERROR");
    }
  };

  child.stdout.on("data", (chunk) => {
    state.buffer += chunk.toString("utf8");
    let index;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString("utf8");
    if (state.stderr.length > 12000) state.stderr = state.stderr.slice(-6000);
  });
  child.on("error", (error) => {
    activeChildren.delete(child);
    finishSearch(state, `搜索引擎启动失败：${error.message}`, "ENGINE_SPAWN_FAILED");
  });
  child.on("close", (code) => {
    activeChildren.delete(child);
    if (state.timer) clearTimeout(state.timer);
    if (!state.done) {
      const detail = state.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `引擎退出码 ${code}`;
      finishSearch(state, `搜索引擎提前退出：${detail.slice(-500)}`, "ENGINE_EXITED");
    }
  });
}

function searchSnapshot(state) {
  return {
    state: "succeeded",
    cached: Boolean(state.finishedAt && Date.now() - state.createdAt < SEARCH_TTL),
    keyword: state.keyword,
    total: [...state.results.values()].reduce((sum, item) => sum + item.songs.length, 0),
    songs: [...state.results.values()].flatMap((item) => item.songs),
    sources: state.sources.map((id) => ({
      id,
      name: SOURCES[id]?.name || id,
      ...(state.results.get(id) || { songs: [], ok: false, error: state.error || "搜索中" }),
    })),
    error: state.error,
    errorCode: state.errorCode,
  };
}

async function waitForSearch(state) {
  if (state.done) return;
  await new Promise((resolve) => {
    state.waiters.add(resolve);
    setTimeout(resolve, (state.timeoutSec + 15) * 1000);
  });
}

function parseSearchParams(url) {
  const keyword = String(url.searchParams.get("keywords") || url.searchParams.get("q") || "").trim().slice(0, 120);
  const sources = capSources(parseSources(url.searchParams.get("sources") || defaultSources().join(",")), MAX_SOURCES_PER_SEARCH);
  const limit = clamp(url.searchParams.get("limit") || defaultLimit(), 1, 20);
  const timeoutSec = clamp(url.searchParams.get("timeoutSec") || defaultTimeout(), 10, 180);
  const refresh = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
  return { keyword, sources, limit, timeoutSec, refresh };
}

function normalizeMatchText(value) {
  return String(value || "").toLowerCase().replace(/[\s\-_·・.,，。!！?？'"“”‘’()（）[\]【】]/g, "");
}

function pickBestSong(songs, name, singer) {
  const targetName = normalizeMatchText(name);
  const targetSinger = normalizeMatchText(singer);
  let best = null;
  let bestScore = -1;
  for (const song of songs) {
    const songName = normalizeMatchText(song.name);
    let score = 0;
    if (targetName && songName === targetName) score += 60;
    else if (targetName && (songName.includes(targetName) || targetName.includes(songName))) score += 35;
    if (targetSinger) {
      const songSinger = normalizeMatchText(song.singer);
      if (songSinger && songSinger.includes(targetSinger)) score += 40;
      else if (songSinger && targetSinger.includes(songSinger)) score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      best = song;
    }
  }
  return best;
}

async function handleResolve(url, res) {
  const name = String(url.searchParams.get("name") || "").trim().slice(0, 80);
  const singer = String(url.searchParams.get("singer") || "").trim().slice(0, 80);
  const keyword = String(url.searchParams.get("keywords") || `${name} ${singer}`).trim().slice(0, 120);
  if (!keyword) {
    json(res, 400, { state: "failed", error: "缺少歌名" });
    return;
  }
  const primary = parseSources(url.searchParams.get("sources") || "kugou", ["kugou"]);
  const limit = clamp(url.searchParams.get("limit") || 10, 1, 20);
  const timeoutSec = clamp(url.searchParams.get("timeoutSec") || defaultTimeout(), 10, 180);
  const fallback = String(url.searchParams.get("fallback") || "all").toLowerCase();
  const attempts = [primary];
  if (!["0", "off", "false"].includes(fallback)) {
    const rest = defaultSources().filter((id) => !primary.includes(id));
    if (rest.length) attempts.push(rest);
  }
  let lastError = "";
  for (const sources of attempts) {
    const state = getSearch(keyword, sources, limit, timeoutSec);
    await waitForSearch(state);
    if (state.errorCode === "NEEDS_ENGINE") {
      json(res, 200, { state: "failed", code: "NEEDS_ENGINE", keyword, error: state.error });
      return;
    }
    const pool = [...state.results.values()].flatMap((item) => item.songs);
    const song = pickBestSong(pool, name || keyword, singer);
    if (song) {
      json(res, 200, { state: "succeeded", keyword, song, source: song.source });
      return;
    }
    lastError = state.error || "没有找到可播放的结果";
  }
  json(res, 200, { state: "failed", keyword, error: lastError || "没有找到可播放的结果", hint: "可以换个音源，或直接在搜索页手动找" });
}

async function runPlaylistParse(url) {
  const cached = playlists.get(url);
  if (cached && Date.now() - cached.at < PLAYLIST_TTL) return cached.value;
  if (cached?.pending) return cached.pending;

  const promise = new Promise((resolve) => {
    const command = buildPlaylistCommand(url, PLAYLIST_TIMEOUT);
    if (command.error === "NEEDS_ENGINE") {
      resolve({ ok: false, error: "搜索引擎尚未安装，请先点击「一键安装搜索引擎」", code: "NEEDS_ENGINE", songs: [] });
      return;
    }
    let child;
    try {
      child = spawn(command.cmd, command.args, {
        cwd: PLUGIN_ROOT,
        env: engineEnv({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }),
        windowsHide: true,
        shell: command.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: `无法启动搜索引擎：${error?.message || error}`, songs: [] });
      return;
    }
    activeChildren.add(child);
    let buffer = "";
    let settled = false;
    let stderr = "";
    let result = null;
    const finish = (fallbackError = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve(result || { ok: false, error: fallbackError || "歌单解析没有返回结果", songs: [] });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(`歌单解析超时（${PLAYLIST_TIMEOUT} 秒），可以换更短的歌单`);
    }, (PLAYLIST_TIMEOUT + 10) * 1000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "playlist") {
          const songs = [];
          const seen = new Set();
          for (const raw of event.songs || []) {
            const song = registerSong(raw, event.source || "playlist");
            if (!song) continue;
            const key = `${song.name.toLowerCase()}|${song.singer.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            songs.push(song);
          }
          result = {
            ok: Boolean(songs.length),
            source: event.source || "",
            sourceName: event.sourceName || SOURCES[event.source]?.name || "",
            songs,
            error: String(event.error || ""),
          };
        } else if (event.type === "error") {
          result = { ok: false, error: String(event.message || "歌单解析失败"), songs: [] };
          finish();
        } else if (event.type === "done") {
          finish();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      result = { ok: false, error: `无法启动搜索引擎：${error.message}`, songs: [] };
      finish();
    });
    child.on("close", () => {
      const detail = stderr.trim().split(/\r?\n/).slice(-1)[0] || "";
      finish(detail ? `歌单解析失败：${detail.slice(-200)}` : "");
    });
  });

  playlists.set(url, { at: Date.now(), pending: promise, value: null });
  const value = await promise;
  playlists.set(url, { at: Date.now(), pending: null, value });
  return value;
}

async function handlePlaylist(url, res) {
  const target = String(url.searchParams.get("url") || url.searchParams.get("playlistUrl") || "").trim().slice(0, 600);
  if (!/^https?:\/\//i.test(target)) {
    json(res, 400, { state: "failed", error: "请粘贴完整的歌单链接（以 http:// 或 https:// 开头）" });
    return;
  }
  const result = await runPlaylistParse(target);
  if (!result.ok) {
    json(res, 200, {
      state: "failed",
      url: target,
      code: result.code || "",
      error: result.error || "没有解析到可播放曲目",
      hint: "支持网易云 / QQ / 酷狗 / 酷我 / 咪咕 / B站 / 喜马拉雅等平台的歌单与专辑链接",
      songs: [],
    });
    return;
  }
  json(res, 200, {
    state: "succeeded",
    url: target,
    source: result.source,
    sourceName: result.sourceName,
    total: result.songs.length,
    songs: result.songs,
  });
}

function handleSearchStream(req, res, params) {
  if (!params.keyword) {
    json(res, 400, { state: "failed", error: "缺少搜索关键词" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const state = getSearch(params.keyword, params.sources, params.limit, params.timeoutSec, params.refresh);
  const send = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  send({
    type: "meta",
    keyword: state.keyword,
    sources: state.sources.map((id) => ({ id, name: SOURCES[id]?.name || id })),
    limit: state.limit,
    cached: state.done && Date.now() - state.createdAt < SEARCH_TTL,
    engine: engineInfo(),
  });
  for (const [sourceId, result] of state.results) {
    send({ type: "source", source: sourceId, name: SOURCES[sourceId]?.name || sourceId, ...result });
  }
  if (state.done) {
    if (state.error) send({ type: "error", code: state.errorCode, message: state.error });
    send({
      type: "done",
      total: [...state.results.values()].reduce((sum, item) => sum + item.songs.length, 0),
      errors: [...state.results.entries()].filter(([, value]) => !value.ok).map(([id, value]) => ({ source: id, message: value.error })),
    });
    res.end();
    return;
  }

  const ping = setInterval(() => send({ type: "ping" }), 15000);
  let finished = false;
  const client = {
    send,
    end: (doneEvent) => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      send({ ...doneEvent, type: "done" });
      if (!res.writableEnded) res.end();
    },
  };
  state.clients.add(client);
  const cleanup = () => {
    finished = true;
    clearInterval(ping);
    state.clients.delete(client);
  };
  res.on("close", cleanup);
}

function buildUpstreamHeaders(entry, req, withReferer = true) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(entry.headers)) {
    headers.set(key, value);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_UA);
  if (withReferer && entry.referer && !headers.has("referer")) headers.set("referer", entry.referer);
  if (!withReferer) headers.delete("referer");
  if (!headers.has("accept")) headers.set("accept", "*/*");
  const cookie = Object.entries(entry.cookies).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
  if (req.headers.range) headers.set("range", String(req.headers.range));
  return headers;
}

async function fetchUpstream(entry, req, method, withReferer = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(entry.url, {
      method,
      headers: buildUpstreamHeaders(entry, req, withReferer),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { response, controller };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function responseContentType(entry, upstream) {
  const raw = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (raw.startsWith("audio/") || ["application/ogg", "application/flac", "application/x-flac", "video/mp4"].includes(raw)) return raw;
  return mimeForExt(entry.ext);
}

async function handleAudio(req, res, entry, options = {}) {
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const attachment = Boolean(options.attachment);
  let upstream = null;
  let lastError = "";
  for (const withReferer of [true, false]) {
    try {
      const attempt = await fetchUpstream(entry, req, method, withReferer);
      if ([401, 403].includes(attempt.response.status) && withReferer) {
        try { await attempt.response.body?.cancel(); } catch { /* ignore */ }
        lastError = `HTTP ${attempt.response.status}（已尝试去除 Referer）`;
        continue;
      }
      upstream = attempt;
      break;
    } catch (error) {
      lastError = String(error?.message || error);
    }
  }
  if (!upstream) {
    json(res, 502, { state: "failed", error: `音源直链不可用：${lastError || "连接失败"}`, source: entry.sourceName, hint: "这条直链可能已过期，请换一首或换一个音源" });
    return;
  }
  const { response, controller } = upstream;
  const status = response.status;
  if (status >= 400) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    json(res, 502, { state: "failed", error: `上游返回 HTTP ${status}`, source: entry.sourceName, hint: "这条直链可能已过期，请换一首或换一个音源" });
    return;
  }
  res.statusCode = status === 206 ? 206 : 200;
  res.setHeader("Content-Type", responseContentType(entry, response));
  res.setHeader("Accept-Ranges", response.headers.get("accept-ranges") || "bytes");
  const contentLength = response.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  const contentRange = response.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);
  res.setHeader("Cache-Control", "public, max-age=1800");
  res.setHeader("Content-Disposition", attachment ? contentDisposition(safeFilename(entry)) : "inline");
  res.setHeader("X-Music-Plaza", `${entry.source}-${entry.ext}`);

  if (method === "HEAD" || !response.body) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    res.end();
    return;
  }
  res.flushHeaders?.();
  const body = Readable.fromWeb(response.body);
  const abort = () => controller.abort();
  res.on("close", () => {
    if (!res.writableFinished) {
      abort();
      body.destroy();
    }
  });
  body.on("error", (error) => {
    log(`audio stream error ${entry.id}: ${error.message}`);
    if (!res.writableEnded) res.destroy(error);
  });
  body.pipe(res);
}

async function handleCover(req, res, entry) {
  if (!entry.cover) {
    json(res, 404, { state: "failed", error: "没有封面" });
    return;
  }
  const cached = coverCache.get(entry.id);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) {
    res.writeHead(200, { "Content-Type": cached.ctype, "Cache-Control": "public, max-age=3600", "Content-Length": cached.body.length });
    res.end(cached.body);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { "user-agent": DEFAULT_UA, accept: "image/*,*/*;q=0.8" };
    if (entry.referer) headers.referer = entry.referer;
    const response = await fetch(entry.cover, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_COVER_BYTES) throw new Error("封面过大");
    let ctype = String(response.headers.get("content-type") || "").split(";")[0].trim();
    if (!ctype.startsWith("image/")) ctype = "image/jpeg";
    coverCache.set(entry.id, { body: buffer, ctype, at: Date.now() });
    if (coverCache.size > 200) {
      const oldest = [...coverCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, coverCache.size - 200);
      for (const [key] of oldest) coverCache.delete(key);
    }
    res.writeHead(200, { "Content-Type": ctype, "Cache-Control": "public, max-age=3600", "Content-Length": buffer.length });
    res.end(buffer);
  } catch (error) {
    clearTimeout(timer);
    json(res, 502, { state: "failed", error: `封面加载失败：${error?.message || error}` });
  }
}

async function handleLyric(req, res, entry) {
  if (entry.lyricText) {
    json(res, 200, { state: "succeeded", lyrics: entry.lyricText, source: entry.sourceName });
    return;
  }
  if (!entry.lyric) {
    json(res, 200, { state: "succeeded", lyrics: "", source: entry.sourceName });
    return;
  }
  if (!/^https?:\/\//i.test(entry.lyric)) {
    entry.lyricText = entry.lyric;
    json(res, 200, { state: "succeeded", lyrics: entry.lyricText, source: entry.sourceName });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { "user-agent": DEFAULT_UA, accept: "*/*" };
    if (entry.referer) headers.referer = entry.referer;
    const response = await fetch(entry.lyric, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    entry.lyricText = text;
    json(res, 200, { state: "succeeded", lyrics: text, source: entry.sourceName });
  } catch (error) {
    clearTimeout(timer);
    json(res, 200, { state: "succeeded", lyrics: "", error: `歌词加载失败：${error?.message || error}`, source: entry.sourceName });
  }
}

function findEntry(id) {
  if (!/^[a-z0-9-]{8,64}$/i.test(String(id || ""))) return null;
  const entry = entries.get(String(id));
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ENTRY_TTL) {
    entries.delete(entry.id);
    return null;
  }
  return entry;
}

function cleanup() {
  const now = Date.now();
  for (const [key, state] of searches) {
    if (state.done && state.clients.size === 0 && now - state.createdAt > SEARCH_TTL) searches.delete(key);
  }
  for (const [id, entry] of entries) if (now - entry.createdAt > ENTRY_TTL) entries.delete(id);
  for (const [id, item] of coverCache) if (now - item.at > 60 * 60 * 1000) coverCache.delete(id);
  for (const [key, item] of playlists) if (!item.pending && now - item.at > PLAYLIST_TTL) playlists.delete(key);
}

const server = http.createServer(async (req, res) => {
  try {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/__health") {
      json(res, 200, {
        ok: true,
        service: "music-plaza",
        version: VERSION,
        pid: process.pid,
        port: PORT,
        engine: engineInfo(),
        defaultSources: defaultSources(),
        sourceCount: sourceList().length,
        sources: sourceList(),
      });
      return;
    }
    if (pathname === "/api/config") {
      json(res, 200, {
        state: "succeeded",
        version: VERSION,
        ...catalogPayload(),
        defaultSources: defaultSources(),
        limit: defaultLimit(),
        timeoutSec: defaultTimeout(),
        concurrency: defaultConcurrency(),
        engine: engineInfo(),
      });
      return;
    }
    if (pathname === "/api/search/stream") {
      handleSearchStream(req, res, parseSearchParams(url));
      return;
    }
    if (pathname === "/api/search") {
      const params = parseSearchParams(url);
      if (!params.keyword) {
        json(res, 400, { state: "failed", error: "缺少搜索关键词" });
        return;
      }
      const state = getSearch(params.keyword, params.sources, params.limit, params.timeoutSec, params.refresh);
      await waitForSearch(state);
      json(res, 200, searchSnapshot(state));
      return;
    }
    if (pathname === "/api/playlist") {
      await handlePlaylist(url, res);
      return;
    }
    if (pathname === "/api/ranks") {
      try {
        const data = await kugouRankList();
        json(res, 200, { state: "succeeded", ...data, hint: "点开榜单查看歌曲；点歌时自动按歌名搜索取流" });
      } catch (error) {
        json(res, 502, { state: "failed", source: "kugou", error: `酷狗榜单暂时不可用：${error?.message || error}` });
      }
      return;
    }
    const rankMatch = pathname.match(/^\/api\/rank\/([a-z0-9-]+)\/(\d+)$/i);
    if (rankMatch) {
      if (rankMatch[1].toLowerCase() !== "kugou") {
        json(res, 404, { state: "failed", error: "暂只支持酷狗榜单" });
        return;
      }
      const page = clamp(url.searchParams.get("page") || 1, 1, 100);
      const pagesize = clamp(url.searchParams.get("pagesize") || 30, 1, 100);
      try {
        const data = await kugouRankSongs(rankMatch[2], page, pagesize);
        let meta = null;
        try {
          meta = (await kugouRankList()).ranks.find((entry) => entry.id === data.rankid) || null;
        } catch { /* 列表临时失败不影响歌曲数据 */ }
        json(res, 200, {
          state: "succeeded",
          source: "kugou",
          cached: data.cached,
          rank: {
            id: data.rankid,
            name: meta?.name || "",
            cover: meta?.cover || "",
            updateFrequency: meta?.updateFrequency || "",
            playCount: meta?.playCount || 0,
            intro: meta?.intro || "",
          },
          page: data.page,
          pagesize: data.pagesize,
          total: data.total,
          hasMore: data.hasMore,
          songs: data.songs,
        });
      } catch (error) {
        json(res, 502, { state: "failed", source: "kugou", error: `酷狗榜单暂时不可用：${error?.message || error}` });
      }
      return;
    }
    if (pathname === "/api/resolve") {
      await handleResolve(url, res);
      return;
    }
    const audioMatch = pathname.match(/^\/api\/(?:audio|stream)\/([a-z0-9-]+)$/i);
    if (audioMatch) {
      const entry = findEntry(audioMatch[1]);
      if (!entry) {
        json(res, 404, { state: "failed", error: "播放链接已过期，请重新搜索", hint: "本地代理只缓存约 90 分钟" });
        return;
      }
      await handleAudio(req, res, entry);
      return;
    }
    const downloadMatch = pathname.match(/^\/api\/download\/([a-z0-9-]+)$/i);
    if (downloadMatch) {
      const entry = findEntry(downloadMatch[1]);
      if (!entry) {
        json(res, 404, { state: "failed", error: "下载链接已过期，请重新搜索", hint: "本地代理只缓存约 90 分钟" });
        return;
      }
      if (entry.kind === "collection") {
        json(res, 400, { state: "failed", error: "有声专辑请按单集下载" });
        return;
      }
      await handleAudio(req, res, entry, { attachment: true });
      return;
    }
    const coverMatch = pathname.match(/^\/api\/cover\/([a-z0-9-]+)$/i);
    if (coverMatch) {
      const entry = findEntry(coverMatch[1]);
      if (!entry) {
        json(res, 404, { state: "failed", error: "封面链接已过期" });
        return;
      }
      await handleCover(req, res, entry);
      return;
    }
    const lyricMatch = pathname.match(/^\/api\/lyric\/([a-z0-9-]+)$/i);
    if (lyricMatch) {
      const entry = findEntry(lyricMatch[1]);
      if (!entry) {
        json(res, 404, { state: "failed", error: "歌词链接已过期" });
        return;
      }
      await handleLyric(req, res, entry);
      return;
    }
    const songMatch = pathname.match(/^\/api\/song\/([a-z0-9-]+)$/i);
    if (songMatch) {
      const entry = findEntry(songMatch[1]);
      if (!entry) {
        json(res, 404, { state: "failed", error: "歌曲不存在或已过期" });
        return;
      }
      json(res, 200, {
        state: "succeeded",
        song: {
          id: entry.id,
          kind: entry.kind,
          source: entry.source,
          sourceName: entry.sourceName,
          name: entry.name,
          singer: entry.singer,
          ext: entry.ext,
          cover: entry.cover ? `/api/cover/${entry.id}` : "",
          streamUrl: `/api/audio/${entry.id}`,
          lyricUrl: `/api/lyric/${entry.id}`,
          downloadUrl: entry.kind === "collection" ? "" : `/api/download/${entry.id}`,
        },
      });
      return;
    }
    json(res, 404, { state: "failed", error: "Not found" });
  } catch (error) {
    log(`request failed: ${error?.stack || error}`);
    if (!res.writableEnded) json(res, 500, { state: "failed", error: String(error?.message || error) });
  }
});

server.on("error", (error) => {
  log(`server error: ${error.message}`);
  if (error.code === "EADDRINUSE") process.exit(2);
});

server.listen(PORT, HOST, () => {
  ensureHome();
  writeJson(SERVER_PID, { pid: process.pid, port: PORT, service: "music-plaza", startedAt: new Date().toISOString() });
  log(`listening on http://${HOST}:${PORT}`);
});

setInterval(cleanup, 5 * 60 * 1000).unref?.();

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  if (server.listening) server.close();
  for (const child of activeChildren) {
    try { child.kill(); } catch { /* ignore */ }
  }
  try {
    const saved = readJson(SERVER_PID, null);
    if (saved && Number(saved.pid) === process.pid) fs.rmSync(SERVER_PID, { force: true });
  } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error?.stack || error}`);
});
