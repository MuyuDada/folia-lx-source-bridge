// lx-source-bridge 代理功能测试：纯本地回环，无外网依赖
// 运行：node test/proxy.test.mjs（Node 18+）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const assert = require('node:assert')
const http = require('node:http')
const { createRuntime, resolveMusicUrl, probeFinalUrl, audioProxy } = require('../index.cjs').__internals

const log = { info: () => {}, warn: () => {}, error: (...a) => console.log('[error]', ...a) }

// 目标音频服务器：支持 Range
const AUDIO = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
const target = http.createServer((req, res) => {
  const range = req.headers.range
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/)
    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : AUDIO.length - 1
    res.writeHead(206, {
      'Content-Type': 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${AUDIO.length}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    })
    res.end(AUDIO.subarray(start, end + 1))
  } else {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes' })
    res.end(AUDIO)
  }
})
await new Promise(r => target.listen(0, '127.0.0.1', r))
const targetUrl = `http://127.0.0.1:${target.address().port}/song.mp3`

const redirector = http.createServer((req, res) => {
  res.writeHead(302, { Location: targetUrl })
  res.end()
})
await new Promise(r => redirector.listen(0, '127.0.0.1', r))

audioProxy.start(log)
await audioProxy.ready(log)

// 1. probeFinalUrl 跟随重定向到终点
const probed = await probeFinalUrl(`http://127.0.0.1:${redirector.address().port}/jump`)
assert.strictEqual(probed.url, targetUrl)
assert.strictEqual(probed.statusCode, 200)
console.log('1. probeFinalUrl redirect OK')

// 2. 脚本返回 http 地址 → resolveMusicUrl 转本地代理地址；3. 代理 Range 拉流 206
const rt = createRuntime({ log })
rt.run(`const { EVENT_NAMES, on, send } = globalThis.lx
send(EVENT_NAMES.inited, { sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } } })
on(EVENT_NAMES.request, () => Promise.resolve(${JSON.stringify(targetUrl)}))`)
const r1 = await resolveMusicUrl(rt, { source: 'wy', song: { id: '30612793' }, quality: 'high' })
assert.match(r1.url, /^http:\/\/127\.0\.0\.1:\d+\/a\/[0-9a-f]{24}$/, r1.url)

const got = await new Promise((resolve, reject) => {
  http.get(r1.url, { headers: { Range: 'bytes=10-19' } }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  }).on('error', reject)
})
assert.strictEqual(got.status, 206)
assert.strictEqual(got.headers['content-range'], `bytes 10-19/${AUDIO.length}`)
assert.strictEqual(got.body.toString(), 'abcdefghij')
console.log('2+3. http URL → 本地代理 → Range 拉流 OK')

// 4. 未知 token → 404
const missing = await new Promise(resolve => {
  http.get(`http://127.0.0.1:${new URL(r1.url).port}/a/deadbeef`, res => resolve(res.statusCode))
})
assert.strictEqual(missing, 404)
console.log('4. unknown token 404 OK')

// 5. https 地址走快速路径，不过代理
rt.run(`const { EVENT_NAMES, on, send } = globalThis.lx
send(EVENT_NAMES.inited, { sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } } })
on(EVENT_NAMES.request, () => Promise.resolve('https://example.com/x.mp3'))`)
const r2 = await resolveMusicUrl(rt, { source: 'wy', song: { id: '1' }, quality: 'high' })
assert.strictEqual(r2.url, 'https://example.com/x.mp3')
console.log('5. https fast path OK')

// 6. 占位地址流程：302 / 并发去重 / 失败 502
const b64url = str => Buffer.from(str, 'utf8').toString('base64url')
let handlerCalls = 0
audioProxy.setPlaceholderHandler(async payload => {
  handlerCalls++
  await new Promise(r => setTimeout(r, 80))
  if (payload.song.id === 'fail') throw new Error('all chains dead')
  return { url: targetUrl, quality: '320k' }
})
const mkPlaceholder = id =>
  `http://127.0.0.1:${audioProxy.port()}/p/${b64url(JSON.stringify({ source: 'wy', quality: '320k', song: { id, title: 't', artist: 'a', album: '' } }))}`

const p1 = await fetch(mkPlaceholder('ok1'), { redirect: 'manual' })
assert.strictEqual(p1.status, 302, `占位地址应 302，实际 ${p1.status}`)
assert.strictEqual(p1.headers.get('location'), targetUrl)

handlerCalls = 0
const [ra, rb] = await Promise.all([
  fetch(mkPlaceholder('dedup'), { redirect: 'manual' }),
  fetch(mkPlaceholder('dedup'), { redirect: 'manual' }),
])
assert.strictEqual(ra.status, 302)
assert.strictEqual(rb.status, 302)
assert.strictEqual(handlerCalls, 1, `并发应去重，实际 handler 调用 ${handlerCalls} 次`)

const pf = await fetch(mkPlaceholder('fail'), { redirect: 'manual' })
assert.strictEqual(pf.status, 502)
assert.strictEqual((await fetch(mkPlaceholder('fail'), { redirect: 'manual' })).status, 502)
console.log('6. placeholder flow OK (302 + dedup + 502)')

audioProxy.close()
rt.dispose()
target.close()
redirector.close()
console.log('ALL PROXY TESTS PASSED')
