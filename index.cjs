// LX 自定义音源桥 — main 入口（Electron 主进程，Node 环境）
//
// 职责：
//   1. 加载用户提供的 LX Music 自定义源脚本（<数据目录>/source.js），在 node:vm 沙箱里运行；
//   2. 用 Node 原生能力实现 LX 桌面版的 globalThis.lx 宿主 API（request / utils.buffer / utils.crypto / utils.zlib）；
//   3. 通过 rpc 向 client 暴露「解析播放地址 / 查状态 / 换脚本 / 重载」。
//
// LX 自定义源脚本规范见 https://lxmusic.toside.cn/desktop/custom-source
// 模组平台规范见 folia-major 仓库 mods/README.md（omni.hooks / omni.providers 为实验接口）。

'use strict'

const vm = require('node:vm')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const { URL, URLSearchParams } = require('node:url')

const SCRIPT_FILE = 'source.js'
const RESOLVE_TIMEOUT_MS = 30_000
const SCRIPT_DL_TIMEOUT_MS = 35_000
const MAX_REDIRECTS = 5

// folia 的音质档位 → LX 脚本的 qualitys 值
const QUALITY_MAP = { standard: '128k', high: '320k', lossless: 'flac', hires: 'flac24bit' }
const QUALITY_ORDER = ['128k', '320k', 'flac', 'flac24bit']

const EVENT_NAMES = {
  request: 'request', // 宿主 → 脚本：解析播放地址
  inited: 'inited', // 脚本 → 宿主：初始化完成，声明 sources
  updateAlert: 'updateAlert', // 脚本 → 宿主：更新弹窗
}

// ---------------------------------------------------------------- 工具

function parseHeader(code) {
  const meta = { name: '', description: '', version: '', author: '', homepage: '' }
  const block = code.match(/\/\*[\s\S]*?\*\//)
  if (block) {
    for (const line of block[0].split('\n')) {
      const hit = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/)
      if (hit && hit[1] in meta) meta[hit[1]] = hit[2]
    }
  }
  return { ...meta, rawScript: code }
}

function safeText(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（超过 ${ms}ms）`)), ms)
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(safeText(err ?? '脚本返回被拒绝')))
      },
    )
  })
}

// 脚本声明的 qualitys 里挑一档：精确 → 不高于请求的最近一档 → 最低一档
function pickQuality(supported, want) {
  if (!Array.isArray(supported) || supported.length === 0) return want
  if (supported.includes(want)) return want
  const rank = new Map(QUALITY_ORDER.map((q, i) => [q, i]))
  const sorted = supported.filter(q => rank.has(q)).sort((a, b) => rank.get(a) - rank.get(b))
  if (sorted.length === 0) return want
  const wantRank = rank.get(want)
  const atOrBelow = sorted.filter(q => rank.get(q) <= wantRank)
  return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : sorted[0]
}

// folia 歌曲（FoliumSong 字段子集）→ LX 脚本认识的 musicInfo。
// 映射依据：folia 内置 provider 的 mediaId（netease=数字 id，kugou=hash，qq=songmid）
// 以及 LX 脚本对内置源 musicInfo 的惯用字段。
function toMusicInfo(source, song = {}) {
  const id = String(song.id ?? '')
  const common = { name: song.title ?? '', singer: song.artist ?? '', albumName: song.album ?? '' }
  switch (source) {
    case 'wy':
      return { ...common, songmid: id, songId: /^\d+$/.test(id) ? Number(id) : id }
    case 'kg':
      // 部分脚本解 flac 还要 albumId（数字专辑 id），FoliumSong 只有专辑名，给空串
      return { ...common, hash: id, albumId: String(song.albumId ?? ''), hash128: id }
    case 'tx':
      return { ...common, songmid: id, mediaMid: id, songId: id }
    case 'kw':
      return { ...common, songmid: id, musicId: id }
    case 'mg':
      return { ...common, songmid: id, copyrightId: id, songId: id }
    default:
      return { ...common, songmid: id }
  }
}

// ---------------------------------------------------------------- lx.request（对齐洛雪桌面版 needle 实现）
//
// 洛雪 preload.js 的语义（必须逐项一致，脚本按此编写）：
//   - 回调 (err, resp, body)；err 时 (err, null, null)
//   - body = resp.raw.toString('utf8')，随后无条件尝试 JSON.parse（成功则 body 是对象）
//   - resp = { statusCode, statusMessage, headers, bytes, raw, body }，raw 保留 Buffer
//   - 不跟随重定向（needle 默认 follow_max=0）
//   - 超时 response_timeout = min(timeout, 60000)，缺省 60000
//   - GET/HEAD + form/formData → 拼进查询串；其他方法 form → urlencoded、formData → multipart

function httpRequest(url, options = {}, callback = () => {}) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  const method = String(options.method || 'get').toUpperCase()
  const headers = { ...options.headers }
  let body = options.body
  let queryData = null

  try {
    if (options.form != null) {
      if (method === 'GET' || method === 'HEAD') {
        queryData = options.form
      } else {
        body =
          typeof options.form === 'string' ? options.form : new URLSearchParams(options.form).toString()
        if (headers['Content-Type'] == null && headers['content-type'] == null) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded'
        }
      }
    } else if (options.formData != null) {
      if (method === 'GET' || method === 'HEAD') {
        queryData = options.formData
      } else {
        const boundary = `----lxbridge${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
        const parts = []
        for (const [key, field] of Object.entries(options.formData)) {
          if (field == null) continue
          if (typeof field === 'object' && !Buffer.isBuffer(field)) {
            const { value, type, filename } = field
            parts.push(
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${key}"` +
                  (filename ? `; filename="${filename}"` : '') +
                  '\r\n',
              ),
            )
            if (type) parts.push(Buffer.from(`Content-Type: ${type}\r\n`))
            parts.push(Buffer.from('\r\n'))
            parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
          } else {
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n`))
            parts.push(Buffer.isBuffer(field) ? field : Buffer.from(String(field)))
          }
          parts.push(Buffer.from('\r\n'))
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`))
        body = Buffer.concat(parts)
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      }
    }
  } catch (err) {
    callback(err, null, null)
    return () => {}
  }

  let target = url
  if (queryData != null) {
    const qs = new URLSearchParams(queryData).toString()
    if (qs) target = `${url}${url.includes('?') ? '&' : '?'}${qs}`
  }

  if (body != null && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)
  } else {
    body = undefined
  }

  const timeout = Number(options.timeout) > 0 ? Math.min(Number(options.timeout), 60_000) : 60_000
  let cancelled = false
  let current = null

  const u = new URL(target)
  const mod = u.protocol === 'https:' ? https : http
  const req = mod.request(
    { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
    res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        if (cancelled) return
        const raw = Buffer.concat(chunks)
        let body = raw.toString('utf8')
        try {
          body = JSON.parse(body)
        } catch {}
        callback(
          null,
          {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            bytes: raw.length,
            raw,
            body,
          },
          body,
        )
      })
      res.on('error', err => {
        if (!cancelled) callback(err, null, null)
      })
    },
  )
  req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）`)))
  req.on('error', err => {
    if (!cancelled) callback(err, null, null)
  })
  if (body != null) req.write(body)
  req.end()
  current = req

  return () => {
    cancelled = true
    try {
      current?.destroy()
    } catch {}
  }
}

// ---------------------------------------------------------------- http 播放地址的落地
//
// Folia 的播放页是安全上下文，脚本给的 http:// 地址会被当作混合内容拒绝（MEDIA_ELEMENT_ERROR:
// Format error）。处理顺序：http → 跟随重定向，终点是 https 就直接用终点；
// 终点仍是 http → 交本地回环代理中转（http://127.0.0.1:<port>/a/<token>，支持 Range，可拖进度条）。

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const audioProxy = (() => {
  let server = null
  let port = 0
  let readyPromise = null
  let placeholderHandler = null
  const tokens = new Map()
  // 占位地址的解析缓存：key = source|songId|quality，值是共享的解析 Promise（去重 + 10 分钟 TTL）
  const resolveCache = new Map()
  const RESOLVE_TTL_MS = 10 * 60_000

  const sweepResolve = () => {
    const now = Date.now()
    for (const [key, entry] of resolveCache) {
      if (now - entry.at > RESOLVE_TTL_MS) resolveCache.delete(key)
    }
  }

  const getOrCreateResolve = (key, payload) => {
    sweepResolve()
    let entry = resolveCache.get(key)
    if (!entry) {
      entry = {
        at: Date.now(),
        promise: (async () => (await placeholderHandler(payload)).url)(),
      }
      entry.promise.catch(() => {
        if (resolveCache.get(key) === entry) resolveCache.delete(key)
      })
      resolveCache.set(key, entry)
    }
    return entry.promise
  }

  const handlePlaceholder = (u, clientRes) => {
    let payload = null
    try {
      payload = JSON.parse(Buffer.from(u.pathname.slice(3), 'base64url').toString('utf8'))
    } catch {}
    if (!placeholderHandler || !payload?.source || typeof payload.song?.id !== 'string') {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      clientRes.end('bad placeholder')
      return
    }
    const key = `${payload.source}|${payload.song.id}|${payload.quality ?? ''}`
    getOrCreateResolve(key, payload).then(
      url => {
        clientRes.writeHead(302, { Location: url })
        clientRes.end()
      },
      err => {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        clientRes.end(String(err?.message ?? '解析失败'))
      },
    )
  }

  const sweep = () => {
    const now = Date.now()
    for (const [key, entry] of tokens) {
      if (now - entry.createdAt > 15 * 60_000) tokens.delete(key)
    }
    while (tokens.size > 64) tokens.delete(tokens.keys().next().value)
  }

  const start = log => {
    if (server) return readyPromise
    server = http.createServer((clientReq, clientRes) => {
      let u
      try {
        u = new URL(clientReq.url, 'http://127.0.0.1')
      } catch {
        clientRes.writeHead(400)
        clientRes.end()
        return
      }
      if (u.pathname.startsWith('/p/')) {
        handlePlaceholder(u, clientRes)
        return
      }
      const token = decodeURIComponent(u.pathname.split('/').pop() || '')
      const entry = tokens.get(token)
      if (!entry) {
        clientRes.writeHead(404, { 'Content-Type': 'text/plain' })
        clientRes.end('expired')
        return
      }
      const headers = { 'User-Agent': BROWSER_UA, ...entry.headers }
      if (clientReq.headers.range) headers.Range = clientReq.headers.range
      let sent = false
      let upstream = null
      const attempt = (target, hops) => {
        const u = new URL(target)
        const mod = u.protocol === 'https:' ? https : http
        upstream = mod.request(
          { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
          res => {
            if (hops < MAX_REDIRECTS && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.resume()
              attempt(new URL(res.headers.location, target).toString(), hops + 1)
              return
            }
            sent = true
            const out = {}
            for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
              if (res.headers[h.toLowerCase()]) out[h] = res.headers[h.toLowerCase()]
            }
            if (!out['Content-Type']) out['Content-Type'] = 'audio/mpeg'
            clientRes.writeHead(res.statusCode, out)
            res.pipe(clientRes)
            clientRes.on('close', () => res.destroy())
          },
        )
        upstream.setTimeout(20_000, () => upstream.destroy(new Error('upstream timeout')))
        upstream.on('error', err => {
          if (!sent) {
            sent = true
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' })
            clientRes.end(String(err?.message ?? 'upstream error'))
          }
        })
        upstream.end()
      }
      attempt(entry.target, 0)
      clientReq.on('close', () => {
        try {
          upstream?.destroy()
        } catch {}
      })
    })
    server.on('error', err => {
      log?.error('音频代理启动失败', err)
      readyPromise = null
      server = null
    })
    readyPromise = new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        log?.info(`音频代理已启动：http://127.0.0.1:${port}`)
        resolve()
      })
    })
    return readyPromise
  }

  return {
    start,
    async ready(log) {
      if (!server) start(log)
      await readyPromise
    },
    setPlaceholderHandler(fn) {
      placeholderHandler = fn
    },
    prefetch(payload) {
      const key = `${payload.source}|${payload.song.id}|${payload.quality ?? ''}`
      return getOrCreateResolve(key, payload)
    },
    port: () => port,
    register(target, headers = {}) {
      sweep()
      const token = crypto.randomBytes(12).toString('hex')
      tokens.set(token, { target, headers, createdAt: Date.now() })
      return `http://127.0.0.1:${port}/a/${token}`
    },
    close() {
      try {
        server?.close()
      } catch {}
      server = null
      port = 0
      readyPromise = null
      tokens.clear()
      resolveCache.clear()
    },
  }
})()

// GET 跟随重定向，只取终点（不下载正文）
function probeFinalUrl(url, headers = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { 'User-Agent': BROWSER_UA, ...headers },
      },
      res => {
        if (hops < MAX_REDIRECTS && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          probeFinalUrl(new URL(res.headers.location, url).toString(), headers, hops + 1).then(resolve, reject)
          return
        }
        const out = { url, statusCode: res.statusCode, headers: res.headers }
        res.resume()
        resolve(out)
      },
    )
    req.setTimeout(15_000, () => req.destroy(new Error('探测超时')))
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------- 运行时（globalThis.lx shim + vm 沙箱）

function createRuntime({ log }) {
  const handlers = new Map()
  const state = { loaded: false, inited: null, alert: null }
  let info = { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' }
  const pendingCancels = new Set()

  const request = (url, options, callback) => {
    const cancel = httpRequest(url, options, (err, resp, body) => {
      pendingCancels.delete(cancel)
      callback(err, resp, body)
    })
    pendingCancels.add(cancel)
    return cancel
  }

  const runZlib = (fn, buf) =>
    new Promise((resolve, reject) =>
      fn(Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? ''), (err, out) =>
        err ? reject(err) : resolve(out),
      ),
    )

  const lx = {
    version: '1.0.0',
    env: 'desktop', // 桌面版固定值；按桌面版规范跑脚本
    EVENT_NAMES,
    get currentScriptInfo() {
      return { ...info }
    },
    on(name, handler) {
      if (typeof name !== 'string' || typeof handler !== 'function') {
        throw new TypeError('lx.on(name, handler) 参数不合法')
      }
      handlers.set(name, handler)
    },
    send(name, datas) {
      if (name === EVENT_NAMES.inited) {
        if (!datas || typeof datas !== 'object' || !datas.sources) {
          throw new TypeError('inited 事件缺少 sources 字段')
        }
        state.inited = datas
        state.alert = null
      } else if (name === EVENT_NAMES.updateAlert) {
        state.alert = datas
        log.info(`脚本 updateAlert：${safeText(datas?.log ?? datas)}`)
      } else {
        log.warn(`脚本发送了未支持的事件：${name}`)
      }
    },
    request,
    utils: {
      buffer: {
        from: (input, encoding) => Buffer.from(input, encoding),
        bufToString: (buf, format) => {
          const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
          return format === 'hex' || format === 'base64' ? b.toString(format) : b.toString('utf8')
        },
      },
      crypto: {
        md5: data => crypto.createHash('md5').update(Buffer.isBuffer(data) ? data : String(data)).digest('hex'),
        randomBytes: size => crypto.randomBytes(size),
        aesEncrypt: (buffer, mode, key, iv) => {
          let algo = String(mode).toLowerCase()
          const noPad = algo.includes('nopad')
          algo = algo.replace(/-?nopad/g, '')
          const cipher = crypto.createCipheriv(algo, key, /ecb/.test(algo) ? null : iv)
          cipher.setAutoPadding(!noPad)
          return Buffer.concat([cipher.update(buffer), cipher.final()])
        },
        rsaEncrypt: (buffer, key) =>
          crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, buffer),
      },
      zlib: {
        inflate: buf => runZlib(zlib.inflate, buf),
        deflate: buf => runZlib(zlib.deflate, buf),
      },
    },
  }

  const run = code => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('脚本文本为空')
    info = parseHeader(code)
    state.loaded = false
    state.inited = null
    state.alert = null
    handlers.clear()

    const scriptConsole = {}
    for (const level of ['log', 'debug', 'info', 'warn', 'error']) {
      scriptConsole[level] = (...args) => {
        const line = `[lx 脚本] ${args.map(safeText).join(' ')}`
        if (level === 'error') log.error(line)
        else if (level === 'warn') log.warn(line)
        else log.info(line)
      }
    }

    const sandbox = {
      console: scriptConsole,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      atob,
      btoa,
      lx,
    }
    const context = vm.createContext(sandbox)
    vm.runInContext(code, context, { filename: 'lx-source.js' })
    state.loaded = true
  }

  const dispose = () => {
    for (const cancel of pendingCancels) {
      try {
        cancel()
      } catch {}
    }
    pendingCancels.clear()
    handlers.clear()
    state.loaded = false
  }

  return {
    lx,
    run,
    dispose,
    handlers,
    state,
    log,
    get info() {
      return info
    },
  }
}

// ---------------------------------------------------------------- 播放地址解析（宿主 → 脚本）

async function resolveMusicUrl(rt, { source, song, quality }) {
  const handler = rt.handlers.get(EVENT_NAMES.request)
  if (!handler) throw new Error('脚本没有注册 request 处理器（脚本未运行或初始化失败）')

  const conf = rt.state.inited?.sources?.[source]
  if (!conf) {
    const known = Object.keys(rt.state.inited?.sources ?? {}).join('、') || '无'
    throw new Error(`脚本未声明音源 ${source}（可用：${known}）`)
  }
  if (Array.isArray(conf.actions) && conf.actions.length > 0 && !conf.actions.includes('musicUrl')) {
    throw new Error(`音源 ${source} 不支持 musicUrl`)
  }

  const want = QUALITY_MAP[quality] || String(quality || '320k')
  const use = pickQuality(conf.qualitys, want)
  const result = await withTimeout(
    Promise.resolve().then(() =>
      handler({ source, action: 'musicUrl', info: { type: use, musicInfo: toMusicInfo(source, song) } }),
    ),
    RESOLVE_TIMEOUT_MS,
    `脚本解析 ${source} ${use} 播放地址超时`,
  )
  const url0 = typeof result === 'string' ? result : result?.url
  if (typeof url0 !== 'string' || !/^https?:\/\//i.test(url0)) {
    throw new Error(`脚本返回的不是有效的 http(s) 地址：${safeText(url0)}`)
  }

  // http 地址先跟随重定向找 https 终点；到不了就交给本地回环代理
  let url = url0
  if (/^http:\/\//i.test(url0)) {
    const log = rt.log
    try {
      const probe = await probeFinalUrl(url0)
      if (probe.statusCode >= 200 && probe.statusCode < 300 && /^https:\/\//i.test(probe.url)) {
        url = probe.url
      } else {
        if (probe.statusCode < 200 || probe.statusCode >= 300) {
          log?.warn(
            `脚本返回的地址探测结果为 HTTP ${probe.statusCode}（多半是脚本的上游接口失效），仍交由本地代理重试一次`,
          )
        }
        await audioProxy.ready(log)
        url = audioProxy.register(probe.statusCode >= 200 && probe.statusCode < 300 ? probe.url : url0)
      }
    } catch (err) {
      log?.warn(`播放地址探测失败（${err?.message ?? err}），交由本地代理中转`)
      await audioProxy.ready(log)
      url = audioProxy.register(url0)
    }
  }
  return { url, quality: use }
}

// ---------------------------------------------------------------- 模组入口

function statusOf(rt, scriptFile) {
  const sources = {}
  for (const [id, conf] of Object.entries(rt.state.inited?.sources ?? {})) {
    sources[id] = {
      name: conf?.name ?? id,
      type: conf?.type ?? 'music',
      actions: Array.isArray(conf?.actions) ? conf.actions : [],
      qualitys: Array.isArray(conf?.qualitys) ? conf.qualitys : [],
    }
  }
  return {
    loaded: Boolean(rt.state.loaded && rt.state.inited),
    fileMissing: !fs.existsSync(scriptFile),
    proxyPort: audioProxy.port(),
    script: {
      name: rt.info.name,
      version: rt.info.version,
      author: rt.info.author,
      description: rt.info.description,
      homepage: rt.info.homepage,
    },
    file: scriptFile,
    sources,
    updateAlert: rt.state.alert,
  }
}

module.exports = function activate(api) {
  const dataDir = api.storage.paths.data
  const scriptFile = path.join(dataDir, SCRIPT_FILE)
  fs.mkdirSync(dataDir, { recursive: true })
  audioProxy.start(api.log)

  const rt = createRuntime({ log: api.log })
  audioProxy.setPlaceholderHandler(payload => resolveMusicUrl(rt, payload))
  let selfWritingUntil = 0
  let watchTimer = null

  const notifyChanged = () => {
    if (api.host.folium.minor >= 7 && typeof api.rpc.send === 'function') {
      try {
        api.rpc.send('lx.statusChanged')
      } catch {}
    }
  }

  const runFile = () => {
    if (!fs.existsSync(scriptFile)) {
      api.log.info(
        `尚未找到音源脚本（${scriptFile}）。把脚本复制到该目录并命名为 source.js，或在模组设置里填写脚本下载地址。`,
      )
      return
    }
    try {
      rt.run(fs.readFileSync(scriptFile, 'utf8'))
      api.log.info(
        `LX 源脚本已加载：${rt.info.name || '(未命名)'}${rt.info.version ? ` v${rt.info.version}` : ''}`,
      )
      notifyChanged()
    } catch (err) {
      api.log.error('LX 源脚本加载失败', err)
      notifyChanged()
    }
  }

  runFile()

  let watcher = null
  try {
    watcher = fs.watch(dataDir, (_event, filename) => {
      if (Date.now() < selfWritingUntil) return
      if (filename != null && filename !== SCRIPT_FILE) return
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        api.log.info('检测到脚本文件变化，重新加载')
        runFile()
      }, 400)
    })
  } catch (err) {
    api.log.warn('脚本目录监视不可用（仍可手动执行重载命令）', err)
  }

  api.rpc.handle('lx.status', () => statusOf(rt, scriptFile))

  api.rpc.handle('lx.resolve', ({ source, song, quality } = {}) =>
    resolveMusicUrl(rt, { source, song, quality }),
  )

  // 预热：client 在钩子里 fire-and-forget 调用，与 /p/ 占位地址共享同一份解析缓存（去重）
  api.rpc.handle('lx.prefetch', ({ source, song, quality } = {}) => {
    if (!source || typeof song?.id !== 'string') return false
    audioProxy
      .prefetch({ source, song, quality })
      .catch(() => {})
    return true
  })

  api.rpc.handle('lx.setScriptUrl', ({ url } = {}) => {
    const target = String(url ?? '').trim()
    if (!/^https?:\/\//i.test(target)) throw new Error('需要 http(s) 脚本地址')
    return new Promise((resolve, reject) => {
      httpRequest(target, { timeout: SCRIPT_DL_TIMEOUT_MS }, (err, resp, body) => {
        if (err) return reject(new Error(`下载脚本失败：${err.message}`))
        if (resp.statusCode !== 200) {
          return reject(new Error(`下载脚本失败：HTTP ${resp.statusCode}`))
        }
        try {
          const code = body.toString('utf8')
          selfWritingUntil = Date.now() + 1500
          fs.writeFileSync(scriptFile, code, 'utf8')
          rt.run(code)
          notifyChanged()
          resolve(statusOf(rt, scriptFile))
        } catch (runErr) {
          reject(runErr)
        }
      })
    })
  })

  api.rpc.handle('lx.setScript', ({ code } = {}) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('脚本文本为空')
    selfWritingUntil = Date.now() + 1500
    fs.writeFileSync(scriptFile, code, 'utf8')
    rt.run(code)
    notifyChanged()
    return statusOf(rt, scriptFile)
  })

  api.rpc.handle('lx.reload', () => {
    runFile()
    return statusOf(rt, scriptFile)
  })

  api.rpc.handle('lx.openScriptDir', () => {
    require('electron').shell.openPath(dataDir)
    return { path: dataDir }
  })

  return () => {
    clearTimeout(watchTimer)
    try {
      watcher?.close()
    } catch {}
    rt.dispose()
    audioProxy.close()
  }
}

// 供冒烟测试与调试用；宿主只读函数本身，附加属性无副作用
module.exports.__internals = {
  EVENT_NAMES,
  QUALITY_MAP,
  parseHeader,
  pickQuality,
  toMusicInfo,
  httpRequest,
  createRuntime,
  resolveMusicUrl,
  probeFinalUrl,
  audioProxy,
}
