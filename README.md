# 音乐广场（一次搜索，几十个音源同时响）

> 想听一首歌，得先去 A 站搜一圈没有、再去 B 站、再去 C 站；好不容易找到，直链还带防盗链，复制出来放不了。
>
> 若道音乐广场基于 [musicdl](https://github.com/CharlesPikachu/musicdl) 做聚合：**一次关键词并发搜索几十个音乐与有声平台**，先返回的先展示，拿到的直链由本机服务代理转发，自动补齐 Referer / UA / Cookie 并支持 Range 分段——拖动进度条也不卡。音源目录是一个 JSON，想加平台改一行就行。

**📦 安装**：这是若道桌面端的功能插件。下载本仓库 ZIP，在「功能插件市场 → 插件管理 → 从本地安装」导入即可（不需登录）。

---

## 💎 五个理由

### 🌐 1. 几十个音源并发，先到的先播

音源分五组：国内音乐 / 海外平台 / 有声读物 / 聚合网关 / 第三方站点，并提供「快速四源」「国内主力」「有声读物」「海外精选」「聚合网关」预设。默认 8 并发、每个音源独立超时，某个源挂了不影响其他结果。

### 🔗 2. 直链能放，因为它站在你本机转发

很多平台的直链带 Referer 校验、防盗链、跨域限制，直接塞进播放器就是 403。插件的本地服务（`127.0.0.1:16120`）替你补齐请求头转发，还支持 `Range: 206` 分段——**能拖进度条、能断点续传**。

### 📚 3. 有声书不是"一首歌"，是"一本书"

喜马拉雅 / 懒人听书 / 荔枝FM / 蜻蜓FM / Apple 播客返回的专辑会自动展开成「专辑 + 分集」，支持整本顺序播放、按集下载。

### 💾 4. 播放、下载、歌单解析，一套东西

`/api/playlist` 按链接域名选对应客户端解析整张歌单，解析完可播放、入队或批量下载（一次最多 30 首），下载保留中文文件名。封面走本地代理，歌词抓 LRC 解析成逐行时间轴，点一下跳到对应位置。

### 🧰 5. 环境自己装，装不上会告诉你为什么

插件声明了 `requires.runtimes: ["python"]` 与 `setup` 命令，装完自动补齐 Python → 安装 musicdl 搜索内核 → 启动本地代理，每一步结果都回传到安装弹窗。Windows 上如果只有 embeddable Python（没有 venv），会自动改用 `pip --target` 的可移植依赖目录，**不污染系统 Python**。

## 🖼️ 界面预览

| 搜索结果 | 榜单 |
| --- | --- |
| [![搜索结果](docs/screenshots/1.png)](docs/screenshots/1.png) | [![榜单](docs/screenshots/2.png)](docs/screenshots/2.png) |

| 歌单 | 我的收藏 |
| --- | --- |
| [![歌单](docs/screenshots/3.png)](docs/screenshots/3.png) | [![我的收藏](docs/screenshots/4.png)](docs/screenshots/4.png) |

## ✨ 功能总览

| 能力 | 说明 |
| --- | --- |
| 🩺 **环境自检** | Python、musicdl 引擎、本地播放服务状态，零费用 |
| 🧩 **一键装搜索引擎** | 创建插件私有 Python 环境并安装 musicdl（首次约 100–200MB），后台执行、进度可查 |
| 🔍 **聚合搜索** | `{ keywords, sources?, limit?, timeoutSec? }`，返回可播放直链与来源信息 |
| 🎧 **本地播放服务** | 渐进搜索、音频代理转发、封面/歌词代理，固定监听 `127.0.0.1:16120` |
| 📃 **歌单解析** | 按链接域名选择对应客户端解析整单 |
| ⬇️ **下载** | 与播放共用代理，改为 attachment 并保留中文文件名，支持批量 |
| 🔁 **重置引擎** | 删除私有运行环境与安装状态，用于修复装坏的情况（不影响插件本体） |

## 📥 安装

1. 下载并安装 [若道桌面端](https://ruodao.com)。
2. 「功能插件市场」→ 搜索 **音乐广场** → 安装；装完会自动准备 Python 与搜索内核。
3. 打开工作台，等「首次使用自检」跑完（Python → musicdl → 本地代理三项都绿）。

## 🚀 使用教程

- **搜歌**：输入关键词，结果按音源分组陆续出现；点「播放」即由本地服务转发。
- **听有声书**：切到「有声读物」预设，搜索书名，专辑会自动展开成分集，整本连播。
- **整张歌单搬过来**：粘贴歌单链接进「歌单」页签，解析后可批量入队或下载。
- **收藏**：收藏时会重新取一次流，避免直链过期点不开。

## 🛠️ 二次开发

```
sources.json              # 音源目录唯一真源（平台 / 分组 / 预设 / className）
bin/plaza.mjs             # 命令入口：doctor / setup / engine_* / search / server_*
bin/plaza-server.mjs      # 本地 HTTP 服务：搜索流、歌单、下载、音频/封面/歌词代理
bin/sources.mjs           # 音源目录读取与解析
bin/ranks.mjs             # 榜单
bin/shared.mjs            # 路径、状态文件与进程工具
python/musicdl_search.py  # musicdl 桥接：逐音源 NDJSON 事件、有声专辑展开、歌单解析
test/                     # 本地服务测试与 mock 引擎
```

**加一个音源**：在 `sources.json` 里登记 musicdl 的客户端类名（`className`）和分组，Node 服务与 Python 内核都会自动读到——不用改代码。

```bash
node --test test/
```

## 💾 数据目录

默认 `~/.ruodao/music-plaza`（可用 `RUODAO_PLAZA_HOME` 覆盖），里面是插件私有的 Python 环境、引擎状态、安装日志与服务日志，删掉即重置。

## 📦 更新日志

- **v1.3.0**（当前开源版本）：音源并发池与五组预设、有声专辑展开、歌单解析、音频代理 Range 支持、可移植依赖目录。

## ⚖️ 说明

聚合能力来自 [musicdl](https://github.com/CharlesPikachu/musicdl)（PolyForm Noncommercial 1.0.0），本项目不提供任何音乐内容，仅供个人学习研究，请支持正版。

## 🔗 相关

- 若道官网：[https://ruodao.com](https://ruodao.com)
- 更多插件源码：[https://github.com/ruodaoai](https://github.com/ruodaoai)

## License

MIT（插件本体）；依赖遵循其原有许可证。
