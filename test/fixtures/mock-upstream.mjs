#!/usr/bin/env node
/**
 * Mock audio/cover/lyric upstream for proxy tests.
 *
 * Audio requires a Referer header and supports Range so tests can verify the
 * local proxy both adds anti-hotlink headers and passes partial content.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const LRC = "[00:00.00]音乐广场测试\n[00:03.20]本地代理歌词\n[00:08.40]结束\n";
const AUDIO_SIZE = 256 * 1024;

/** 6 秒 8kHz 单声道 16-bit PCM，供 Electron 里真实解码播放 */
function buildWav() {
  const rate = 8000;
  const seconds = 6;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const fade = Math.min(1, index / 800, (samples - index) / 800);
    const value = Math.sin((2 * Math.PI * 440 * index) / rate) * 0.25 * fade;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

const WAV = buildWav();

export async function startMockUpstream({ port = 0 } = {}) {
  const requests = [];
  const audio = Buffer.alloc(AUDIO_SIZE);
  for (let index = 0; index < audio.length; index += 1) audio[index] = index % 251;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    const pathname = new URL(req.url || "/", "http://mock.local").pathname;
    const referer = String(req.headers.referer || "");
    // 封面由渲染层直连加载（真实酷狗图床不校验来源），其余路由模拟防盗链
    const imageRoute = pathname === "/cover.png" || /^\/cover-\d+\.png$/.test(pathname);
    if (!referer && !imageRoute) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("missing referer");
      return;
    }
    if (pathname === "/audio.mp3") {
      const range = String(req.headers.range || "");
      let start = 0;
      let end = AUDIO_SIZE - 1;
      let partial = false;
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        partial = true;
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), AUDIO_SIZE - 1);
        if (!match[1] && match[2]) {
          start = Math.max(0, AUDIO_SIZE - Number(match[2]));
          end = AUDIO_SIZE - 1;
        }
      }
      if (start > end || start >= AUDIO_SIZE) {
        res.writeHead(416, { "Content-Range": `bytes */${AUDIO_SIZE}` });
        res.end();
        return;
      }
      const body = audio.subarray(start, end + 1);
      res.writeHead(partial ? 206 : 200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": body.length,
        "Accept-Ranges": "bytes",
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${AUDIO_SIZE}` } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === "/tone.wav") {
      const range = String(req.headers.range || "");
      let start = 0;
      let end = WAV.length - 1;
      let partial = false;
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        partial = true;
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), WAV.length - 1);
        if (!match[1] && match[2]) {
          start = Math.max(0, WAV.length - Number(match[2]));
          end = WAV.length - 1;
        }
      }
      if (start > end || start >= WAV.length) {
        res.writeHead(416, { "Content-Range": `bytes */${WAV.length}` });
        res.end();
        return;
      }
      const body = WAV.subarray(start, end + 1);
      res.writeHead(partial ? 206 : 200, {
        "Content-Type": "audio/wav",
        "Content-Length": body.length,
        "Accept-Ranges": "bytes",
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${WAV.length}` } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === "/cover.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
      res.end(PNG);
      return;
    }
    if (pathname === "/lyric.lrc") {
      const body = Buffer.from(LRC, "utf8");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (pathname === "/api/v3/rank/list") {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        data: {
          total: 2,
          info: [
            { rankid: "8888", rankname: "TOP500", img_9: `${origin}/cover-{size}.png`, update_frequency: "每天", play_times: 9443366, intro: "按播放收藏分享综合排名", haschildren: 0 },
            { rankid: "6666", rankname: "飙升榜", img_9: `${origin}/cover-{size}.png`, update_frequency: "每天", play_times: 18334, intro: "", haschildren: 0 },
          ],
        },
      }));
      return;
    }
    if (pathname === "/api/v3/rank/song") {
      const origin = `http://${req.headers.host}`;
      const rankid = new URL(req.url || "/", "http://mock.local").searchParams.get("rankid");
      if (rankid !== "8888") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unknown rank" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        data: {
          total: 60,
          info: [
            { songname: "海阔天空", authors: [{ author_name: "Beyond" }], remark: "乐与怒", duration: 326, album_sizable_cover: `${origin}/cover-{size}.png`, hash: "AAA111" },
            { songname: "光辉岁月", authors: [{ author_name: "Beyond" }], remark: "命运派对", duration: 302, album_sizable_cover: `${origin}/cover-{size}.png`, hash: "BBB222" },
          ],
        },
      }));
      return;
    }
    if (/^\/cover-\d+\.png$/.test(pathname)) {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
      res.end(PNG);
      return;
    }
    if (pathname === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requests }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    base: `http://127.0.0.1:${actualPort}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_UPSTREAM_PORT || 0) || 0;
  startMockUpstream({ port }).then((upstream) => {
    process.stdout.write(`${JSON.stringify({ base: upstream.base, port: upstream.port })}\n`);
  });
}
