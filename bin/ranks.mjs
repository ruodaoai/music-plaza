/**
 * Kugou chart provider for the Music Plaza local service.
 *
 * Charts come from Kugou's public mobile endpoints (no login, no signature).
 * Only metadata is returned here: playback still resolves through the regular
 * musicdl search + audio proxy pipeline, so chart APIs can change without
 * breaking playback.
 */

const DEFAULT_BASE = "http://mobilecdn.kugou.com";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const LIST_TTL = 30 * 60 * 1000;
const SONGS_TTL = 10 * 60 * 1000;
const MAX_CACHE = 300;

const cache = new Map();

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

export function rankBase() {
  return String(process.env.RUODAO_PLAZA_KUGOU_RANK_BASE || DEFAULT_BASE).trim().replace(/\/+$/, "") || DEFAULT_BASE;
}

function cacheGet(key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_CACHE) {
    const oldest = [...cache.entries()].sort((left, right) => left[1].at - right[1].at).slice(0, cache.size - MAX_CACHE);
    for (const [entryKey] of oldest) cache.delete(entryKey);
  }
}

function imageUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) return "";
  return url.replace("{size}", "480");
}

function fmtDuration(sec) {
  const value = Number(sec) || 0;
  if (!value) return "";
  return `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, "0")}`;
}

async function getJson(pathname, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${rankBase()}${pathname}`, {
      headers: { "user-agent": DEFAULT_UA, referer: "http://m.kugou.com/", accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw new Error(error?.name === "AbortError" ? "上游请求超时" : String(error?.message || error));
  } finally {
    clearTimeout(timer);
  }
}

export async function kugouRankList() {
  const cached = cacheGet("kugou:list", LIST_TTL);
  if (cached) return { ...cached, cached: true };
  const body = await getJson("/api/v3/rank/list?version=9108&plat=0&showtype=2");
  const info = Array.isArray(body?.data?.info) ? body.data.info : [];
  const ranks = [];
  const seen = new Set();
  for (const raw of info) {
    const id = String(raw?.rankid ?? "").trim();
    const name = String(raw?.rankname ?? "").trim();
    if (!id || !name || seen.has(id)) continue;
    if (Number(raw?.haschildren) === 1) continue;
    seen.add(id);
    ranks.push({
      id,
      name,
      cover: imageUrl(raw?.img_9 || raw?.img_cover || raw?.imgurl || raw?.album_img_9 || raw?.banner_9),
      updateFrequency: String(raw?.update_frequency || "").trim(),
      playCount: Number(raw?.play_times) || 0,
      intro: String(raw?.intro || "").replace(/\r/g, "").trim(),
    });
  }
  if (!ranks.length) throw new Error("榜单列表为空");
  const value = { source: "kugou", updatedAt: Date.now(), ranks };
  cacheSet("kugou:list", value);
  return { ...value, cached: false };
}

function normalizeSong(raw, index, page, pagesize) {
  const name = String(raw?.songname || raw?.filename || "").trim();
  if (!name) return null;
  const singers = Array.isArray(raw?.authors)
    ? raw.authors.map((author) => String(author?.author_name || "").trim()).filter(Boolean)
    : [];
  const filenameParts = String(raw?.filename || "").split(" - ");
  const durationSec = Number(raw?.duration) || 0;
  return {
    index: (page - 1) * pagesize + index + 1,
    name,
    singer: singers.join(" / ") || (filenameParts.length > 1 ? filenameParts[0].trim() : ""),
    album: String(raw?.remark || "").trim(),
    duration: fmtDuration(durationSec),
    durationSec,
    cover: imageUrl(raw?.album_sizable_cover),
    hash: String(raw?.hash || ""),
  };
}

export async function kugouRankSongs(rankid, page = 1, pagesize = 30) {
  const id = String(rankid ?? "").replace(/\D/g, "");
  if (!id) throw new Error("榜单 id 无效");
  const currentPage = clamp(page, 1, 1000);
  const size = clamp(pagesize, 1, 100);
  const key = `kugou:${id}:${currentPage}:${size}`;
  const cached = cacheGet(key, SONGS_TTL);
  if (cached) return { ...cached, cached: true };
  const body = await getJson(`/api/v3/rank/song?rankid=${encodeURIComponent(id)}&page=${currentPage}&pagesize=${size}&version=9108`);
  const info = Array.isArray(body?.data?.info) ? body.data.info : [];
  const total = Number(body?.data?.total) || 0;
  const songs = info.map((raw, index) => normalizeSong(raw, index, currentPage, size)).filter(Boolean);
  if (!songs.length) throw new Error("榜单暂无歌曲");
  const value = {
    source: "kugou",
    rankid: id,
    page: currentPage,
    pagesize: size,
    total: Math.max(total, songs.length),
    hasMore: total > currentPage * size || songs.length >= size,
    songs,
  };
  cacheSet(key, value);
  return { ...value, cached: false };
}
