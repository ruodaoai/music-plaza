/**
 * 音源目录（唯一真源：sources.json）。
 *
 * 这里只做读取与索引，不再手写音源表，避免 Node 服务、Python 内核与前端三处漂移。
 * 新增平台：在 sources.json 里登记 musicdl 的客户端类名即可。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = path.join(HERE, "..", "sources.json");

const FALLBACK_SOURCES = [
  { id: "migu", className: "MiguMusicClient", name: "咪咕音乐", short: "咪咕", group: "cn", fast: true, color: "#d9497d", referer: "https://h5.nf.migu.cn/" },
  { id: "kuwo", className: "KuwoMusicClient", name: "酷我音乐", short: "酷我", group: "cn", fast: true, color: "#3f7bd9", referer: "https://www.kuwo.cn/" },
  { id: "kugou", className: "KugouMusicClient", name: "酷狗音乐", short: "酷狗", group: "cn", fast: true, color: "#2e9df7", referer: "https://www.kugou.com/" },
  { id: "qianqian", className: "QianqianMusicClient", name: "千千音乐", short: "千千", group: "cn", fast: true, color: "#7b61ff", referer: "https://music.91q.com/player" },
];

function loadCatalog() {
  const fallback = {
    upstream: { project: "musicdl", repo: "https://github.com/CharlesPikachu/musicdl" },
    defaults: FALLBACK_SOURCES.map((entry) => entry.id),
    groups: [{ id: "all", name: "全部", short: "全部", hint: "" }, { id: "cn", name: "国内音乐", short: "国内", hint: "" }],
    presets: [],
    sources: FALLBACK_SOURCES,
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    const sources = Array.isArray(parsed.sources) ? parsed.sources.filter((entry) => entry && entry.id && entry.className) : [];
    if (!sources.length) return fallback;
    return {
      ...fallback,
      ...parsed,
      groups: Array.isArray(parsed.groups) && parsed.groups.length ? parsed.groups : fallback.groups,
      presets: Array.isArray(parsed.presets) ? parsed.presets : [],
      sources,
    };
  } catch {
    return fallback;
  }
}

export const CATALOG = loadCatalog();

export const SOURCES = Object.fromEntries(CATALOG.sources.map((entry) => [entry.id, entry]));

export const SOURCE_GROUPS = CATALOG.groups;

export const DEFAULT_SOURCE_IDS = (CATALOG.defaults || []).filter((id) => SOURCES[id]);

/** 一次挂太多音源会线性拖慢整体；超过此值由服务端收敛。 */
export const MAX_SOURCES_PER_SEARCH = 60;

export function sourceList() {
  return CATALOG.sources.map(({ id, name, short, className, group, fast, color, referer, requires, episodes }) => ({
    id,
    name,
    short: short || name,
    className,
    group: group || "cn",
    fast: Boolean(fast),
    color: color || "#8b8b8b",
    referer: referer || "",
    requires: Array.isArray(requires) ? requires : [],
    episodes: Boolean(episodes),
  }));
}

export function catalogPayload() {
  return {
    upstream: CATALOG.upstream || {},
    sources: sourceList(),
    groups: SOURCE_GROUPS,
    presets: CATALOG.presets,
    defaults: DEFAULT_SOURCE_IDS,
  };
}

function resolveId(piece) {
  const key = String(piece || "").trim().toLowerCase();
  if (!key) return "";
  if (SOURCES[key]) return key;
  const hit = CATALOG.sources.find((entry) => (
    String(entry.className).toLowerCase() === key
    || String(entry.className).replace(/MusicClient$/i, "").toLowerCase() === key
    || String(entry.name).toLowerCase() === key
    || String(entry.short || "").toLowerCase() === key
  ));
  return hit ? hit.id : "";
}

export function parseSources(raw, fallback = DEFAULT_SOURCE_IDS) {
  const text = String(raw ?? "").trim();
  const pieces = text ? text.split(/[,，\s]+/) : fallback;
  const picked = [];
  for (const piece of pieces) {
    const id = resolveId(piece);
    if (id && !picked.includes(id)) picked.push(id);
  }
  return picked.length ? picked.slice(0, MAX_SOURCES_PER_SEARCH) : [...fallback];
}

export function capSources(sources, max = MAX_SOURCES_PER_SEARCH) {
  return [...new Set(sources)].slice(0, max);
}

export const EXT_MIME = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  ape: "audio/x-ape",
  wma: "audio/x-ms-wma",
  tta: "audio/x-tta",
  wv: "audio/x-wavpack",
  aiff: "audio/aiff",
  alac: "audio/mp4",
  m4b: "audio/mp4",
};

export function mimeForExt(ext) {
  const key = String(ext || "").toLowerCase().replace(/^\./, "");
  return EXT_MIME[key] || "application/octet-stream";
}
