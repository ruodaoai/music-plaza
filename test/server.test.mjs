import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMockUpstream } from "./fixtures/mock-upstream.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "bin", "plaza-server.mjs");
const PLAZA = path.join(HERE, "..", "bin", "plaza.mjs");
const MOCK_ENGINE = path.join(HERE, "fixtures", "mock-engine.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnPlaza(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PLAZA, ...args], {
      cwd: path.join(HERE, ".."),
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error?.message || error) }));
    child.stdin.end("{}");
  });
}

function parseNdjson(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function lastComponent(events, id) {
  return events.filter((event) => event.type === "setup" && event.component?.id === id)
    .map((event) => event.component)
    .at(-1);
}

async function stopProxyFrom(home) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
    if (saved?.pid) process.kill(Number(saved.pid));
  } catch { /* already gone */ }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs = 15000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) events.push({ ...JSON.parse(line), at: performance.now() });
    }
  }
  return events;
}

test("music-plaza local service: progressive search, cache, proxy, cover, lyric", async (t) => {
  const upstream = await startMockUpstream();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "music-plaza-test-"));
  const countFile = path.join(home, "engine-runs.log");
  let stderr = "";
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.join(HERE, ".."),
    env: {
      ...process.env,
      RUODAO_PLAZA_HOME: home,
      RUODAO_PLAZA_PORT: String(port),
      RUODAO_PLAZA_ENGINE_CMD: JSON.stringify([process.execPath, MOCK_ENGINE]),
      RUODAO_PLAZA_KUGOU_RANK_BASE: upstream.base,
      MOCK_UPSTREAM: upstream.base,
      MOCK_ENGINE_COUNT_FILE: countFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  t.after(async () => {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(3000)]);
    await upstream.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await waitFor(async () => {
    try {
      const response = await fetch(`${base}/__health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 15000, `plaza server (${stderr.slice(-400)})`);

  const health = await (await fetch(`${base}/__health`)).json();
  assert.equal(health.service, "music-plaza");
  assert.equal(health.engine.ready, false);
  assert.ok(health.sources.some((entry) => entry.id === "migu"));

  // 1) Progressive search stream
  const streamResponse = await fetch(`${base}/api/search/stream?keywords=${encodeURIComponent("测试")}&sources=migu,kuwo,qianqian&limit=8`);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") || "", /ndjson/);
  const events = await readNdjson(streamResponse);
  const types = events.map((event) => event.type);
  assert.equal(types[0], "meta");
  assert.equal(types.at(-1), "done");
  const migu = events.find((event) => event.type === "source" && event.source === "migu");
  const kuwo = events.find((event) => event.type === "source" && event.source === "kuwo");
  const qianqian = events.find((event) => event.type === "source" && event.source === "qianqian");
  assert.ok(migu && kuwo && qianqian);
  assert.equal(migu.songs.length, 2);
  assert.equal(kuwo.songs.length, 1);
  assert.equal(qianqian.ok, false);
  assert.ok(kuwo.at - migu.at > 150, `expected progressive delivery, got ${kuwo.at - migu.at}ms`);
  assert.ok(migu.songs[0].streamUrl.startsWith("/api/audio/"));
  assert.ok(migu.songs[0].cover.startsWith("/api/cover/"));
  assert.equal(migu.songs[0].hasLyric, true);
  assert.equal(migu.songs[0].url, undefined, "direct URLs must stay behind the proxy");
  const done = events.at(-1);
  assert.equal(done.total, 3);
  assert.ok(done.errors.some((entry) => entry.source === "qianqian"));

  // 2) Same query is served from cache (engine runs once)
  const cachedResponse = await fetch(`${base}/api/search?keywords=${encodeURIComponent("测试")}&sources=migu,kuwo,qianqian&limit=8`);
  const cached = await cachedResponse.json();
  assert.equal(cached.state, "succeeded");
  assert.equal(cached.cached, true);
  assert.equal(cached.total, 3);
  assert.equal(cached.sources.find((entry) => entry.id === "qianqian").ok, false);
  const runs = fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean) : [];
  assert.equal(runs.length, 1, "cache should avoid another engine process");

  // 3) Audio proxy adds Referer, preserves source headers and Range
  const song = migu.songs[0];
  const rangeResponse = await fetch(`${base}${song.streamUrl}`, { headers: { Range: "bytes=100-1123" } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-type"), "audio/mpeg");
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 100-1123/${256 * 1024}`);
  const rangeBody = Buffer.from(await rangeResponse.arrayBuffer());
  assert.equal(rangeBody.length, 1024);
  assert.equal(rangeBody[0], 100 % 251);
  const audioRequests = upstream.requests.filter((entry) => entry.url.startsWith("/audio.mp3"));
  const lastAudio = audioRequests.at(-1);
  assert.equal(lastAudio.headers.referer, "https://h5.nf.migu.cn/");
  assert.equal(lastAudio.headers["user-agent"], "MockAgent/1.0");
  assert.equal(lastAudio.headers["x-mock-header"], "migu");
  assert.equal(lastAudio.headers.range, "bytes=100-1123");

  const fullResponse = await fetch(`${base}${song.streamUrl}`);
  assert.equal(fullResponse.status, 200);
  const fullBody = Buffer.from(await fullResponse.arrayBuffer());
  assert.equal(fullBody.length, 256 * 1024);

  // 4) Cover + lyric proxying
  const coverResponse = await fetch(`${base}${song.cover}`);
  assert.equal(coverResponse.status, 200);
  assert.equal(coverResponse.headers.get("content-type"), "image/png");
  assert.ok((await coverResponse.arrayBuffer()).byteLength > 40);

  const lyricResponse = await fetch(`${base}${song.lyricUrl}`);
  const lyric = await lyricResponse.json();
  assert.equal(lyric.state, "succeeded");
  assert.match(lyric.lyrics, /音乐广场测试/);

  // 5) 酷狗榜单：列表 / 歌曲 / 缓存 / 点歌解析
  const rankList = await (await fetch(`${base}/api/ranks`)).json();
  assert.equal(rankList.state, "succeeded");
  assert.equal(rankList.source, "kugou");
  assert.equal(rankList.ranks.length, 2);
  assert.equal(rankList.ranks[0].name, "TOP500");
  assert.equal(rankList.ranks[0].cover, `${upstream.base}/cover-480.png`);
  assert.equal(rankList.ranks[0].updateFrequency, "每天");

  const rankDetail = await (await fetch(`${base}/api/rank/kugou/8888?page=1&pagesize=2`)).json();
  assert.equal(rankDetail.state, "succeeded");
  assert.equal(rankDetail.rank.name, "TOP500");
  assert.equal(rankDetail.total, 60);
  assert.equal(rankDetail.hasMore, true);
  assert.equal(rankDetail.songs.length, 2);
  assert.equal(rankDetail.songs[0].name, "海阔天空");
  assert.equal(rankDetail.songs[0].singer, "Beyond");
  assert.equal(rankDetail.songs[0].duration, "5:26");
  assert.equal(rankDetail.songs[1].index, 2);
  assert.equal(rankDetail.songs[0].cover, `${upstream.base}/cover-480.png`);

  await (await fetch(`${base}/api/ranks`)).json();
  assert.equal(upstream.requests.filter((entry) => entry.url.startsWith("/api/v3/rank/list")).length, 1, "榜单列表应命中缓存");
  const rankUpstreamCalls = upstream.requests.filter((entry) => entry.url.startsWith("/api/v3/rank/song"));
  assert.equal(rankUpstreamCalls.length, 1);
  assert.equal(rankUpstreamCalls[0].headers.referer, "http://m.kugou.com/");

  const badRank = await fetch(`${base}/api/rank/kuwo/8888`);
  assert.equal(badRank.status, 404);

  const resolved = await (await fetch(`${base}/api/resolve?name=${encodeURIComponent("海阔天空")}&singer=Beyond&sources=kugou&limit=5&timeoutSec=20`)).json();
  assert.equal(resolved.state, "succeeded");
  assert.ok(resolved.song.streamUrl.startsWith("/api/audio/"));
  assert.equal(resolved.song.url, undefined, "resolve 也不能暴露直链");
  const resolvedAudio = await fetch(`${base}${resolved.song.streamUrl}`, { headers: { Range: "bytes=0-99" } });
  assert.equal(resolvedAudio.status, 206);

  // 6) Unknown ids are rejected and expired entries are not proxied
  const missing = await fetch(`${base}/api/audio/migu-deadbeefdeadbeef`);
  assert.equal(missing.status, 404);
  const badRange = await fetch(`${base}${song.streamUrl}`, { headers: { Range: "bytes=999999-" } });
  assert.equal(badRange.status, 502);

  // 7) 下载：同一代理 + 附件头 + UTF-8 文件名
  const download = await fetch(`${base}${song.downloadUrl}`);
  assert.equal(download.status, 200);
  const disposition = download.headers.get("content-disposition") || "";
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''/);
  await download.arrayBuffer();

  // 8) 音源目录接口：数十个平台 + 分组 + 预设
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.ok(config.sources.length >= 50, `expected dozens of sources, got ${config.sources.length}`);
  assert.ok(config.sources.some((entry) => entry.id === "ximalaya" && entry.group === "audio"));
  assert.ok(config.groups.some((entry) => entry.id === "audio"));
  assert.ok(Array.isArray(config.presets) && config.presets.length >= 3);

  // 9) 有声专辑：一本书 = collection，章节是独立可播放/可下载条目
  const albumStream = await fetch(`${base}/api/search/stream?keywords=${encodeURIComponent("有声书")}&sources=ximalaya&limit=4`);
  const albumEvents = await readNdjson(albumStream);
  const albumSource = albumEvents.find((event) => event.type === "source" && event.source === "ximalaya");
  assert.ok(albumSource && albumSource.ok);
  const book = albumSource.songs[0];
  assert.equal(book.kind, "collection");
  assert.equal(book.episodes.length, 3);
  assert.equal(book.episodeTotal, 3);
  assert.equal(book.streamUrl, "");
  assert.ok(book.episodes[0].streamUrl.startsWith("/api/audio/"));
  const episodeAudio = await fetch(`${base}${book.episodes[1].streamUrl}`);
  assert.equal(episodeAudio.status, 200);
  assert.ok((await episodeAudio.arrayBuffer()).byteLength > 0);
  const bookDownload = await fetch(`${base}${book.episodes[0].downloadUrl}`);
  assert.equal(bookDownload.status, 200);
  assert.match(bookDownload.headers.get("content-disposition") || "", /^attachment;/);
  await bookDownload.arrayBuffer();

  // 10) 歌单解析：贴链接直接拿到可播放曲目
  const playlist = await (await fetch(`${base}/api/playlist?url=${encodeURIComponent("https://music.163.com/#/playlist?id=123456")}`)).json();
  assert.equal(playlist.state, "succeeded");
  assert.equal(playlist.total, 2);
  assert.equal(playlist.songs[0].name, "歌单曲目1");
  assert.ok(playlist.songs.every((entry) => entry.streamUrl.startsWith("/api/audio/")));
  assert.ok(playlist.songs[0].downloadUrl.startsWith("/api/download/"));
  const badPlaylist = await (await fetch(`${base}/api/playlist?url=not-a-url`)).json();
  assert.equal(badPlaylist.state, "failed");
});

test("source aliases and MIME mapping", async () => {
  const { parseSources, mimeForExt } = await import("../bin/sources.mjs");
  assert.deepEqual(parseSources("migu, MiguMusicClient, qq"), ["migu", "qq"]);
  assert.deepEqual(parseSources("bogus"), ["migu", "kuwo", "kugou", "qianqian"]);
  assert.equal(mimeForExt("flac"), "audio/flac");
  assert.equal(mimeForExt(".m4a"), "audio/mp4");
  assert.equal(mimeForExt("weird"), "application/octet-stream");
});

test("setup reports missing Python as blocked and still starts the proxy", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "music-plaza-setup-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await stopProxyFrom(home);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const result = await spawnPlaza(["setup"], {
    RUODAO_PLAZA_HOME: home,
    RUODAO_PLAZA_PORT: String(port),
    RUODAO_PLAZA_PYTHON: path.join(home, "missing-python"),
    PATH: "",
  });
  assert.equal(result.code, 0, result.stderr);
  const events = parseNdjson(result.stdout);
  assert.equal(events[0].type, "setup");
  assert.equal(events.at(-1).type, "setup-result");

  const ids = [...new Set(events.filter((event) => event.type === "setup").map((event) => event.component.id))];
  assert.deepEqual(ids, ["python", "engine", "server"]);

  const python = lastComponent(events, "python");
  assert.equal(python.status, "failed");
  assert.match(python.detail, /Python 3\.9\+/);
  const engine = lastComponent(events, "engine");
  assert.equal(engine.status, "blocked");
  assert.match(engine.detail, /缺少 Python/);
  const server = lastComponent(events, "server");
  assert.equal(server.status, "ok");
  assert.match(server.detail, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const summary = events.at(-1);
  assert.equal(summary.ok, false, "missing Python must fail the overall check");
  assert.equal(summary.home, home);
  assert.equal(summary.components.length, 3);
  assert.equal(typeof summary.elapsedMs, "number");

  const health = await (await fetch(`${base}/__health`)).json();
  assert.equal(health.service, "music-plaza");
});

test("setup reuses an already installed portable engine without reinstalling", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "music-plaza-setup-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const fakePython = path.join(home, "engine", "python", "python.exe");
  fs.mkdirSync(path.dirname(fakePython), { recursive: true });
  fs.writeFileSync(fakePython, "");
  fs.writeFileSync(path.join(home, "engine-state.json"), JSON.stringify({
    ready: true,
    python: fakePython,
    sitePackages: path.join(home, "engine", "site-packages"),
    mode: "portable",
    version: "2.14.2",
    pythonVersion: "3.13.1",
  }));
  t.after(async () => {
    await stopProxyFrom(home);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const result = await spawnPlaza(["setup"], {
    RUODAO_PLAZA_HOME: home,
    RUODAO_PLAZA_PORT: String(port),
    RUODAO_PLAZA_PYTHON: path.join(home, "missing-python"),
    PATH: "",
  });
  assert.equal(result.code, 0, result.stderr);
  const events = parseNdjson(result.stdout);
  const engine = lastComponent(events, "engine");
  assert.equal(engine.status, "ok");
  assert.match(engine.detail, /musicdl 2\.14\.2/);
  assert.match(engine.detail, /独立依赖目录/);
  assert.equal(fs.existsSync(path.join(home, "install-state.json")), false, "ready engine must not be reinstalled");
  assert.equal(lastComponent(events, "server").status, "ok");
  assert.equal((await fetch(`${base}/__health`)).status, 200);
});
