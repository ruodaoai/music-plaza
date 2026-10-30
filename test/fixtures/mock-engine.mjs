#!/usr/bin/env node
/**
 * Deterministic stand-in for python/musicdl_search.py used by tests and E2E.
 * Emits the same NDJSON protocol, with staggered sources and one failing source.
 */

import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const keywords = arg("keyword", "测试");
const sources = arg("sources", "migu,kuwo,qianqian").split(",").filter(Boolean);
const limit = Number(arg("limit", "8")) || 8;
const playlistUrl = arg("playlist-url", "");
const upstream = (process.env.MOCK_UPSTREAM || "").replace(/\/+$/, "");
const countFile = process.env.MOCK_ENGINE_COUNT_FILE || "";

if (countFile) {
  fs.appendFileSync(countFile, `${Date.now()}\n`, "utf8");
}
if (!upstream) {
  process.stdout.write(`${JSON.stringify({ type: "error", message: "MOCK_UPSTREAM missing" })}\n`);
  process.exit(2);
}

process.stderr.write(`[mock-engine] search ${keywords} sources=${sources.join(",")}\n`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const audioFile = process.env.MOCK_AUDIO_FILE || "/audio.mp3";
const audioExt = process.env.MOCK_AUDIO_EXT || "mp3";

const makeSong = (source, index) => ({
  name: `${keywords}（测试曲目${index + 1}）`,
  singer: source === "migu" ? "咪咕歌手" : "酷我歌手",
  album: "音乐广场测试专辑",
  ext: audioExt,
  duration: "3:20",
  durationSec: 200,
  size: "1.9 MB",
  sizeBytes: 200000,
  cover: `${upstream}/cover.png`,
  lyric: `${upstream}/lyric.lrc`,
  url: `${upstream}${audioFile}?source=${source}&index=${index}`,
  headers: { "User-Agent": "MockAgent/1.0", "X-Mock-Header": source },
  cookies: {},
  identifier: `${source}-${index}`,
  protocol: "HTTP",
});

const makeCollection = (source, bookName, count) => ({
  kind: "collection",
  name: bookName,
  singer: "播讲人",
  album: "有声测试专辑",
  ext: "",
  duration: "",
  durationSec: 0,
  size: "",
  sizeBytes: 0,
  cover: `${upstream}/cover.png`,
  lyric: "",
  url: "",
  headers: {},
  cookies: {},
  episodeTotal: count,
  episodeTruncated: false,
  episodes: Array.from({ length: count }).map((_, index) => ({
    ...makeSong(source, index),
    name: `${bookName} 第${index + 1}集`,
    album: bookName,
    identifier: `${source}-book-${index}`,
  })),
});

/* 歌单 / 专辑解析模式：--playlist-url <url> */
if (playlistUrl) {
  const songs = [makeSong("netease", 0), makeSong("netease", 1)].map((song, index) => ({
    ...song,
    name: `歌单曲目${index + 1}`,
    identifier: `playlist-${index}`,
  }));
  const fail = String(process.env.MOCK_PLAYLIST_FAIL || "") === "1";
  process.stdout.write(`${JSON.stringify({ type: "start", mode: "playlist", url: playlistUrl })}\n`);
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({
      type: "playlist",
      ok: !fail,
      source: "netease",
      sourceName: "网易云音乐",
      songs: fail ? [] : songs,
      count: fail ? 0 : songs.length,
      error: fail ? "模拟歌单解析失败" : "",
    })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "done", completed: [], timedOut: [] })}\n`);
    setTimeout(() => process.exit(0), 20);
  }, 60);
}

const events = {
  migu: {
    delay: 80,
    event: {
      type: "source",
      source: "migu",
      name: "咪咕音乐",
      ok: true,
      elapsedMs: 80,
      songs: [makeSong("migu", 0), makeSong("migu", 1)].slice(0, limit),
    },
  },
  kuwo: {
    delay: 420,
    event: {
      type: "source",
      source: "kuwo",
      name: "酷我音乐",
      ok: true,
      elapsedMs: 420,
      songs: [makeSong("kuwo", 0)].slice(0, limit),
    },
  },
  qianqian: {
    delay: 60,
    event: {
      type: "source",
      source: "qianqian",
      name: "千千音乐",
      ok: false,
      elapsedMs: 60,
      songs: [],
      error: "模拟音源不可用，请换源",
    },
  },
  kugou: {
    delay: 200,
    event: {
      type: "source",
      source: "kugou",
      name: "酷狗音乐",
      ok: true,
      elapsedMs: 200,
      songs: [makeSong("migu", 2)].slice(0, limit),
    },
  },
  ximalaya: {
    delay: 120,
    event: {
      type: "source",
      source: "ximalaya",
      name: "喜马拉雅",
      ok: true,
      elapsedMs: 120,
      songs: [makeCollection("ximalaya", `${keywords}有声书`, 3)].slice(0, limit),
    },
  },
};

if (!playlistUrl) {
  process.stdout.write(`${JSON.stringify({ type: "start", keyword: keywords, sources: sources.map((id) => ({ id, name: id })) })}\n`);

  const pending = new Set(sources);
  const finish = (sourceId) => {
    pending.delete(sourceId);
    if (!pending.size) {
      process.stdout.write(`${JSON.stringify({ type: "done", completed: sources, timedOut: [] })}\n`);
      setTimeout(() => process.exit(0), 20);
    }
  };

  for (const sourceId of sources) {
    const item = events[sourceId];
    if (!item) {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({ type: "source", source: sourceId, name: sourceId, ok: false, songs: [], error: "mock: unknown source" })}\n`);
        finish(sourceId);
      }, 30);
      continue;
    }
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify(item.event)}\n`);
      finish(sourceId);
    }, item.delay);
  }
}
