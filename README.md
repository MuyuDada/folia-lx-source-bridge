# folia-lx-source-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Folium](https://img.shields.io/badge/Folium-1.x-blue)](https://github.com/chthollyphile/folia-major)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/chthollyphile/folia-major/releases)

在 [Folia](https://github.com/chthollyphile/folia-major) 桌面版里运行
[LX Music（洛雪音乐）](https://github.com/lyswhut/lx-music-desktop)的**自定义源脚本**——
一个 Folium 模组。歌单、搜索仍来自 Folia 内置音源（网易云/酷狗/QQ…），播放地址改由你自备的
lx 脚本解析，与洛雪的自定义源语义一致。

> 本项目**不包含、不分发任何音源脚本**，也不下载或存储任何音频内容；它只是让 Folia 能"读懂"
> 你已经拥有的 lx 自定义源脚本。

## 工作原理

```
你点歌（网易云歌单）
        │
        ▼
Folia 内置 provider 解析出地址
        │
        ▼
钩子 omni.audioSourceResolved（同步，1.5s 时限内）
        │  瞬间改写为本地占位地址
        ▼
http://127.0.0.1:<port>/p/<歌曲信息>     ← 播放器来取流时才真正解析
        │
        ▼
main 进程：node:vm 沙箱运行 lx 脚本 ──► 多链路解析（10 分钟缓存 + 并发去重）
        │
        ▼
302 跳转到真实播放地址（http 地址自动经本地代理中转，支持 Range/拖进度条）
```

- **钩子模式**（默认开）：内置音源解析出播放地址后，改用 lx 脚本的地址；脚本不支持的平台保持原样。
- **独立音源**（默认开）：在音源切换器里注册「LX」音源，搜索代理给脚本支持的第一个内置平台，
  歌曲 id 形如 `wy:123456`；封面/时长取自代理平台。

## 安装

前提：Folia 桌面版（Folium 模组系统为实验功能，需 Folia 0.7+）。

1. 从 [Releases](../../releases) 下载 `folia-lx-source-bridge-<版本>.zip`
   （仓库页面的 Source code zip 同样可直接安装）；
2. Folia「设置 → 模组」开启模组系统，把 zip 拖进模组面板（或解压到 `%APPDATA%\Folia\mods`）；
3. 启用模组（系统级二次确认；未签名模组显示「未验证」属正常）；
4. 导入你自己的 lx 自定义源脚本（`.js`），二选一：
   - 命令面板执行「**打开 LX 脚本目录**」，把脚本复制进去命名为 `source.js`（文件变化自动热重载）；
   - 或在模组设置「脚本下载地址」里填脚本的 http(s) 链接，自动下载保存。

放好脚本后点歌即可。模组设置里可选音质（128k/320k/flac/flac24bit，脚本不支持时自动降档）、
开关钩子/独立音源两种模式。

## LX 脚本规范覆盖情况

宿主 API 按洛雪桌面版实现逐项对齐（包括回调交付 utf8 字符串 + 自动 JSON 解析、`resp.raw` 保留
Buffer、不跟随重定向、needle 式 GET 查询串、60s 超时语义）：

| LX API | 实现 |
| --- | --- |
| `EVENT_NAMES` / `on` / `send` | `request` / `inited` / `updateAlert` |
| `request(url, options, callback)` | Node http/https；`method/headers/body/form/formData/timeout`；返回取消函数 |
| `utils.buffer.from / bufToString` | Node Buffer |
| `utils.crypto.md5 / randomBytes / aesEncrypt / rsaEncrypt` | `node:crypto`（AES 支持 ecb/cbc 与 `-nopad`；RSA 为 PKCS1） |
| `utils.zlib.inflate / deflate` | `node:zlib`（Promise） |
| `env` / `version` / `currentScriptInfo` | `desktop` / `1.0.0` / 解析头部 `@name @description @version @author @homepage` |

歌曲 id → `musicInfo` 映射（依据 Folia 内置 provider 的 mediaId 语义与 lx 脚本惯例）：
`wy: { songmid, songId }`、`kg: { hash, albumId:'' }`、`tx: { songmid, mediaMid }`、
`kw: { songmid }`、`mg: { songmid, copyrightId }`，均附带 `name/singer/albumName` 供脚本做元数据兜底。

## 已知限制与 FAQ

- **钩子超时**：Folium 钩子有 1.5s 时限，因此钩子只做瞬时占位改写，脚本解析在播放器取流时进行；
  每首歌第一次播放起播会慢几秒（多链路解析的时间），10 分钟内重播秒开。
- **酷狗部分脚本解无损需要数字 `albumId`**，Folia 只提供专辑名，无法填出。
- **`tx` 的 `mediaMid`** 暂用 `songmid` 代替，个别脚本的部分音质可能失败。
- **独立音源模式下歌词为空**（lx 音乐源脚本不提供歌词）；钩子模式歌词照常走内置音源。
- **聚合类脚本掉到死链**：多链路脚本解析失败时会退到不做健康检查的 URL 模板，模板失效则播放失败，
  日志会写明 `探测结果为 HTTP xxx`。
- 仅 Electron 桌面端可用；Web/PWA 部署形态没有模组系统。
- `omni.hooks` / `omni.providers` 是 Folium 实验接口，可能随宿主版本变化，本项目尽量兼容但请自担风险。

## 开发

```bash
# 语法检查 + 冒烟测试（test/proxy.test.mjs 为纯本地回环，test/smoke.test.mjs 需要外网）
node --check index.cjs && node --check client.mjs
node test/proxy.test.mjs
node test/smoke.test.mjs

# 打可安装的 zip（mod.json 需在 zip 根目录）
zip -j folia-lx-source-bridge.zip mod.json index.cjs client.mjs README.md preview.png
```

推 tag 即可出 Release，CI 会自动把可安装 zip 附到 Release（见 `.github/workflows/release.yml`）。

## 免责声明

- 本项目仅供学习与技术研究，请勿用于商业用途。
- 项目本身**不含任何音源脚本**；你导入的脚本内容与用途由你自行负责，与本项目无关。
- 本项目不下载、不存储、不分发任何音频文件，仅做播放地址解析。
- 使用本项目产生的任何问题由使用者自行承担；如有侵权请联系删除。

## 致谢

- [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 与其
  [自定义源脚本规范](https://lxmusic.toside.cn/desktop/custom-source)
- [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 与 Folium 模组平台

## License

[MIT](LICENSE)
