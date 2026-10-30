#!/usr/bin/env python3
"""musicdl bridge for the Ruodao Music Plaza plugin.

Two modes:

* search (``--keyword``): progressive per-source search. Sources are pulled from
  a bounded worker pool so selecting 50+ platforms does not spawn 50 threads.
* playlist (``--playlist-url``): parse an online playlist / album URL and emit
  the tracks it contains.

All events are newline-delimited JSON on a duplicated stdout fd (library logs
are redirected to stderr). The source catalog lives in ``sources.json`` so Node
and Python cannot drift apart.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
import traceback
from urllib.parse import urlparse

EPISODE_LIMIT = 24
PLAYLIST_HOST_CLASSES = {
    "music.163.com": "NeteaseMusicClient",
    "y.qq.com": "QQMusicClient",
    "i.y.qq.com": "QQMusicClient",
    "c6.y.qq.com": "QQMusicClient",
    "www.kugou.com": "KugouMusicClient",
    "m.kugou.com": "KugouMusicClient",
    "www.kuwo.cn": "KuwoMusicClient",
    "m.kuwo.cn": "KuwoMusicClient",
    "music.migu.cn": "MiguMusicClient",
    "m.music.migu.cn": "MiguMusicClient",
    "www.bilibili.com": "BilibiliMusicClient",
    "b23.tv": "BilibiliMusicClient",
    "www.ximalaya.com": "XimalayaMusicClient",
    "www.lizhi.fm": "LizhiMusicClient",
    "www.qtfm.cn": "QingtingMusicClient",
    "www.lrts.me": "LRTSMusicClient",
    "www.joox.com": "JooxMusicClient",
    "open.spotify.com": "SpotifyMusicClient",
    "music.apple.com": "AppleMusicClient",
    "tidal.com": "TIDALMusicClient",
    "listen.tidal.com": "TIDALMusicClient",
    "play.qobuz.com": "QobuzMusicClient",
    "www.deezer.com": "DeezerMusicClient",
    "www.youtube.com": "YouTubeMusicClient",
    "music.youtube.com": "YouTubeMusicClient",
    "soundcloud.com": "SoundCloudMusicClient",
    "5sing.kugou.com": "FiveSingMusicClient",
    "streetvoice.cn": "StreetVoiceMusicClient",
    "suno.com": "SunoMusicClient",
    "audius.co": "AudiusMusicClient",
}
PLAYLIST_FALLBACK = ["NeteaseMusicClient", "QQMusicClient", "KugouMusicClient", "KuwoMusicClient", "MiguMusicClient"]

_EVENT_STREAM = None
CATALOG: dict = {"sources": {}, "groups": [], "defaults": []}


def catalog_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sources.json")


def load_catalog() -> None:
    global CATALOG
    try:
        with open(catalog_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        entries = {str(item.get("id")): item for item in data.get("sources", []) if isinstance(item, dict) and item.get("id")}
        CATALOG = {
            "sources": entries,
            "groups": data.get("groups", []) or [],
            "defaults": [sid for sid in data.get("defaults", []) if sid in entries],
        }
    except Exception as exc:  # pragma: no cover - catalog ships with the plugin
        log(f"load sources.json failed: {exc}")
        CATALOG = {"sources": {}, "groups": [], "defaults": []}


def setup_event_stream() -> None:
    global _EVENT_STREAM
    try:
        _EVENT_STREAM = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
        os.dup2(2, 1)
        sys.stdout = sys.stderr
    except Exception:
        _EVENT_STREAM = sys.stderr


def emit(payload: dict) -> None:
    stream = _EVENT_STREAM or sys.stderr
    try:
        stream.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        stream.flush()
    except Exception:
        pass


def log(message: str) -> None:
    try:
        sys.stderr.write(f"[music-plaza] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def parse_sources(raw: str) -> list[str]:
    picked: list[str] = []
    entries = CATALOG.get("sources", {})
    for piece in str(raw or "").replace("，", ",").split(","):
        key = piece.strip()
        if not key:
            continue
        lowered = key.lower()
        if key in entries:
            picked.append(key)
            continue
        for source_id, item in entries.items():
            class_name = str(item.get("className", ""))
            if lowered in (
                class_name.lower(),
                class_name.removesuffix("MusicClient").lower(),
                str(item.get("name", "")).lower(),
                str(item.get("short", "")).lower(),
            ):
                picked.append(source_id)
                break
    return list(dict.fromkeys(picked))


def patch_audio_link_tester() -> None:
    """Replace the expensive HEAD+GET sniffing with a short best-effort HEAD.

    musicdl's default tester downloads 8KB and sniffs file types for every
    candidate quality. That is the main reason a search can take minutes.
    Direct URLs are already playable; we only need a usable extension and an
    approximate size here. Real failures are surfaced by the local proxy when
    the user actually plays a track.
    """
    from musicdl.modules.utils.misc import AudioLinkTester

    mime_to_ext = dict(AudioLinkTester.MIME_TO_PREFERRED_EXT)
    valid_exts = set(AudioLinkTester.VALID_AUDIO_EXTS)
    normalize_ct = AudioLinkTester.normalizectype
    suffix_of = AudioLinkTester.extractsuffixfromurl
    byte2mb = AudioLinkTester.byte2mb

    def fast_test(self, url, request_overrides=None, renew_session=True):  # noqa: ANN001
        result = {
            "ok": True,
            "ctype": "",
            "ext": "mp3",
            "original_download_url": url,
            "download_url": url,
            "file_size": "",
            "file_size_bytes": 0,
            "method": "fast-head",
            "status_code": 0,
            "reason": [],
        }
        ext = suffix_of(url) or "mp3"
        if ext not in valid_exts:
            ext = "mp3"
        headers = dict(getattr(self, "headers", None) or {})
        kwargs = dict(request_overrides or {})
        kwargs["headers"] = {**headers, **(kwargs.get("headers") or {})}
        kwargs.setdefault("timeout", (2, 3))
        kwargs.setdefault("allow_redirects", True)
        kwargs.setdefault("verify", getattr(self, "verify", True))
        try:
            resp = self.session.head(url, **kwargs)
            status = int(getattr(resp, "status_code", 0) or 0)
            result["status_code"] = status
            result["download_url"] = str(getattr(resp, "url", "") or url)
            ctype = str((getattr(resp, "headers", {}) or {}).get("Content-Type") or "")
            result["ctype"] = ctype
            ctype_ext = mime_to_ext.get(normalize_ct(ctype) or "")
            if ctype_ext:
                ext = ctype_ext
            length = (getattr(resp, "headers", {}) or {}).get("Content-Length")
            if length and str(length).isdigit():
                result["file_size_bytes"] = int(length)
                result["file_size"] = byte2mb(result["file_size_bytes"])
            if not (200 <= status < 400 or status in (403, 405, 416)):
                result["ok"] = False
                result["reason"].append(f"HEAD returned {status}")
            else:
                result["reason"].append(f"HEAD {status}")
            close = getattr(resp, "close", None)
            if callable(close):
                close()
        except Exception as exc:  # network hiccup: keep the candidate, proxy retries later
            result["reason"].append(f"HEAD skipped: {exc}")
        result["ext"] = ext
        return result

    AudioLinkTester.test = fast_test


def _base_song_payload(song) -> dict | None:  # noqa: ANN001
    from musicdl.modules.utils.misc import AudioLinkTester

    name = str(getattr(song, "song_name", "") or "").strip()
    if not name:
        return None
    ext = AudioLinkTester.normalizeext(getattr(song, "ext", "")) or ""
    headers = getattr(song, "default_download_headers", None)
    cookies = getattr(song, "default_download_cookies", None)
    duration_s = getattr(song, "duration_s", None)
    try:
        duration_s = int(float(duration_s)) if duration_s is not None else 0
    except Exception:
        duration_s = 0
    size_bytes = getattr(song, "file_size_bytes", 0)
    try:
        size_bytes = int(size_bytes or 0)
    except Exception:
        size_bytes = 0
    return {
        "name": name,
        "singer": str(getattr(song, "singers", "") or "").strip(),
        "album": str(getattr(song, "album", "") or "").strip(),
        "ext": ext or "mp3",
        "duration": str(getattr(song, "duration", "") or ""),
        "durationSec": duration_s,
        "size": str(getattr(song, "file_size", "") or ""),
        "sizeBytes": size_bytes,
        "cover": str(getattr(song, "cover_url", "") or ""),
        "lyric": str(getattr(song, "lyric", "") or ""),
        "headers": headers if isinstance(headers, dict) else {},
        "cookies": cookies if isinstance(cookies, dict) else {},
        "identifier": str(getattr(song, "identifier", "") or ""),
        "protocol": str(getattr(song, "protocol", "HTTP") or "HTTP").upper(),
    }


def song_to_dict(song, with_episodes: bool = True) -> dict | None:  # noqa: ANN001
    """Normalize a musicdl SongInfo.

    Audiobook / podcast clients return a *book* whose ``episodes`` hold the real
    playable chapters, so those become ``kind: collection`` nodes with nested
    playable children instead of being dropped for lacking a download URL.
    """
    payload = _base_song_payload(song)
    if payload is None:
        return None

    episodes = getattr(song, "episodes", None) if with_episodes else None
    if isinstance(episodes, list) and episodes:
        children = []
        for episode in episodes[:EPISODE_LIMIT]:
            child = song_to_dict(episode, with_episodes=False)
            if child:
                children.append(child)
        if children:
            payload.update(
                {
                    "kind": "collection",
                    "url": "",
                    "lyric": "",
                    "episodes": children,
                    "episodeTotal": len(episodes),
                    "episodeTruncated": len(episodes) > len(children),
                }
            )
            return payload

    url = getattr(song, "download_url", "")
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        return None
    if payload["protocol"] == "HLS" or payload["ext"] == "m3u8":
        return None
    payload["url"] = url
    payload["kind"] = "song"
    return payload


def dedupe(songs: list[dict], limit: int) -> list[dict]:
    picked: list[dict] = []
    seen: set[str] = set()
    for song in songs:
        key = f"{song.get('name', '').strip().lower()}|{song.get('singer', '').strip().lower()}|{song.get('ext', '')}"
        if key in seen:
            continue
        seen.add(key)
        picked.append(song)
        if len(picked) >= limit:
            break
    return picked


def build_music_client(class_names: list[str], limit: int, work_dir: str):  # noqa: ANN201
    from musicdl.musicdl import MusicClient

    cfg = {}
    for class_name in class_names:
        cfg[class_name] = {
            "search_size_per_source": max(limit, 1),
            "search_size_per_page": min(max(limit, 1), 10),
            "strict_limit_search_size_per_page": True,
            "disable_print": True,
            "max_retries": 1,
            "maintain_session": False,
            # musicdl dumps search_results.pkl under work_dir; use a throwaway
            # directory so the plugin folder and user home stay clean.
            "work_dir": work_dir,
        }
    return MusicClient(
        music_sources=class_names,
        init_music_clients_cfg=cfg,
        clients_threadings={name: 6 for name in class_names},
        requests_overrides={name: {"timeout": (8, 12)} for name in class_names},
    )


def search_one(source_id: str, keywords: str, limit: int, events: queue.Queue) -> None:
    started = time.monotonic()
    item = CATALOG.get("sources", {}).get(source_id, {})
    class_name = str(item.get("className") or "")
    label = str(item.get("name") or source_id)
    work_dir = tempfile.mkdtemp(prefix=f"musicdl-{source_id}-")
    try:
        if not class_name:
            raise RuntimeError(f"音源目录里没有 {source_id}")
        client = build_music_client([class_name], limit, work_dir)
        found = client.search(keyword=keywords).get(class_name, []) or []
        songs = [entry for entry in (song_to_dict(song) for song in found) if entry]
        songs = dedupe(songs, limit)
        events.put(
            {
                "type": "source",
                "source": source_id,
                "name": label,
                "group": item.get("group", ""),
                "ok": True,
                "songs": songs,
                "count": len(songs),
                "elapsedMs": int((time.monotonic() - started) * 1000),
            }
        )
    except Exception as exc:
        log(f"{source_id} failed: {exc}")
        log(traceback.format_exc())
        events.put(
            {
                "type": "source",
                "source": source_id,
                "name": label,
                "group": item.get("group", ""),
                "ok": False,
                "songs": [],
                "error": str(exc)[:400] or exc.__class__.__name__,
                "elapsedMs": int((time.monotonic() - started) * 1000),
            }
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def run_search(keywords: str, sources: list[str], limit: int, timeout: float, concurrency: int) -> None:
    events: queue.Queue = queue.Queue()
    pending: queue.Queue = queue.Queue()
    for source_id in sources:
        pending.put(source_id)

    worker_count = max(1, min(concurrency, len(sources)))

    def worker() -> None:
        while True:
            try:
                source_id = pending.get_nowait()
            except queue.Empty:
                return
            search_one(source_id, keywords, limit, events)

    threads = [threading.Thread(target=worker, name=f"musicdl-worker-{index}", daemon=True) for index in range(worker_count)]
    for thread in threads:
        thread.start()

    deadline = time.monotonic() + timeout
    finished: list[str] = []
    while len(finished) < len(sources):
        remain = deadline - time.monotonic()
        if remain <= 0:
            break
        try:
            event = events.get(timeout=min(remain, 1.0))
        except queue.Empty:
            continue
        emit(event)
        if event.get("type") == "source":
            finished.append(str(event.get("source", "")))

    timed_out = [source_id for source_id in sources if source_id not in finished]
    for source_id in timed_out:
        item = CATALOG.get("sources", {}).get(source_id, {})
        emit(
            {
                "type": "source",
                "source": source_id,
                "name": str(item.get("name") or source_id),
                "group": item.get("group", ""),
                "ok": False,
                "songs": [],
                "error": f"超时（>{int(timeout)} 秒），可换用其他音源",
            }
        )

    emit({"type": "done", "completed": finished, "timedOut": timed_out})


def playlist_candidates(url: str) -> list[str]:
    host = (urlparse(url).hostname or "").lower()
    ordered: list[str] = []
    if host in PLAYLIST_HOST_CLASSES:
        ordered.append(PLAYLIST_HOST_CLASSES[host])
    else:
        for suffix, class_name in PLAYLIST_HOST_CLASSES.items():
            if host.endswith(suffix) and class_name not in ordered:
                ordered.append(class_name)
    for class_name in PLAYLIST_FALLBACK:
        if class_name not in ordered:
            ordered.append(class_name)
    available = {str(item.get("className")) for item in CATALOG.get("sources", {}).values()}
    return [name for name in ordered if not available or name in available]


def run_playlist(url: str, timeout: float) -> None:
    candidates = playlist_candidates(url)[:4]
    work_dir = tempfile.mkdtemp(prefix="musicdl-playlist-")
    state: dict = {"songs": [], "source": "", "parsed": 0, "errors": []}
    lock = threading.Lock()
    found = threading.Event()
    deadline = time.monotonic() + timeout
    try:
        def attempt(name: str) -> None:
            try:
                client = build_music_client([name], 30, work_dir)
                infos = client.parseplaylist(url) or []
                songs = [entry for entry in (song_to_dict(info) for info in infos) if entry]
                with lock:
                    state["parsed"] = max(int(state["parsed"]), len(infos))
                    if songs and not state["songs"]:
                        state["songs"] = songs
                        state["source"] = name
                if songs:
                    found.set()
            except Exception as exc:
                with lock:
                    state["errors"].append(f"{name}: {exc}"[:240])
                log(f"playlist via {name} failed: {exc}")

        threads = [
            threading.Thread(target=attempt, args=(name,), name=f"playlist-{name}", daemon=True)
            for name in candidates
        ]
        for thread in threads:
            thread.start()
        while time.monotonic() < deadline:
            if found.wait(0.25):
                break
            if not any(thread.is_alive() for thread in threads):
                break

        source_id = ""
        if state["source"]:
            source_id = next(
                (sid for sid, item in CATALOG.get("sources", {}).items() if item.get("className") == state["source"]),
                "",
            )
        if state["songs"]:
            error = ""
        elif state["parsed"]:
            error = f"已定位到 {state['parsed']} 首曲目，但都取不到播放地址（多为会员 / 版权限制），可换其他平台歌单或在搜索页手动换源"
        elif state["errors"]:
            error = "、".join(state["errors"][-2:])[:300]
        else:
            error = "没有解析到可播放曲目：可能不是歌单链接、需要登录状态，或该平台的曲目受会员/版权限制。可在搜索页手动找歌。"
        emit(
            {
                "type": "playlist",
                "ok": bool(state["songs"]),
                "source": source_id,
                "sourceName": str(CATALOG.get("sources", {}).get(source_id, {}).get("name") or state["source"] or ""),
                "songs": state["songs"],
                "count": len(state["songs"]),
                "parsedTracks": state["parsed"],
                "error": error,
            }
        )
        emit({"type": "done", "completed": [], "timedOut": []})
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="musicdl bridge")
    parser.add_argument("--keyword")
    parser.add_argument("--playlist-url")
    parser.add_argument("--sources", default="")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()

    setup_event_stream()
    load_catalog()

    if args.version:
        try:
            import musicdl

            emit({"type": "version", "version": getattr(musicdl, "__version__", ""), "sources": len(CATALOG.get("sources", {}))})
            return 0
        except Exception as exc:
            emit({"type": "error", "message": f"musicdl 未安装：{exc}"})
            return 1

    timeout = max(float(args.timeout or 60), 5)
    try:
        patch_audio_link_tester()
    except Exception as exc:
        emit({"type": "error", "message": f"musicdl 加载失败：{exc}"})
        return 3

    if args.playlist_url:
        url = str(args.playlist_url or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            emit({"type": "error", "message": "歌单链接需要以 http(s):// 开头"})
            return 2
        emit({"type": "start", "mode": "playlist", "url": url})
        run_playlist(url, timeout)
        try:
            (_EVENT_STREAM or sys.stderr).flush()
        except Exception:
            pass
        os._exit(0)

    keywords = str(args.keyword or "").strip()
    default_sources = CATALOG.get("defaults") or ["migu", "kuwo", "kugou", "qianqian"]
    sources = parse_sources(args.sources) or parse_sources(",".join(default_sources))
    limit = min(max(int(args.limit or 8), 1), 20)
    if not keywords:
        emit({"type": "error", "message": "搜索关键词为空"})
        return 2
    if not sources:
        emit({"type": "error", "message": "没有可用的搜索音源"})
        return 2

    emit(
        {
            "type": "start",
            "mode": "search",
            "keyword": keywords,
            "sources": [
                {"id": sid, "name": str(CATALOG.get("sources", {}).get(sid, {}).get("name") or sid)}
                for sid in sources
            ],
        }
    )
    run_search(keywords, sources, limit, timeout, max(int(args.concurrency or 8), 1))
    try:
        (_EVENT_STREAM or sys.stderr).flush()
    except Exception:
        pass
    # Worker threads may still be blocked on third-party APIs; exit hard so the
    # Node host gets EOF immediately after the done event.
    os._exit(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
