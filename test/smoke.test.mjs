// lx-source-bridge 冒烟测试：shim 语义 + 脚本链路（部分用例需要外网）
// 运行：node test/smoke.test.mjs（Node 18+）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const assert = require('node:assert')
const { parseHeader, pickQuality, toMusicInfo, createRuntime, resolveMusicUrl, httpRequest } =
  require('../index.cjs').__internals

// 1. 头部解析
const header = parseHeader(`/**
 * @name 测试源
 * @description smoke
 * @version 1.2.3
 * @author tester
 * @homepage https://example.com
 */\nconst x = 1`)
assert.strictEqual(header.name, '测试源')
assert.strictEqual(header.version, '1.2.3')
assert.strictEqual(header.homepage, 'https://example.com')
console.log('1. parseHeader OK')

// 2. 音质挑选：精确 → 不高于请求的最近一档 → 最低一档
assert.strictEqual(pickQuality(['128k', '320k', 'flac'], 'flac'), 'flac')
assert.strictEqual(pickQuality(['128k', '320k'], 'flac24bit'), '320k')
assert.strictEqual(pickQuality(['flac', 'flac24bit'], '128k'), 'flac')
assert.strictEqual(pickQuality([], 'flac'), 'flac')
console.log('2. pickQuality OK')

// 3. musicInfo 映射
const mi = toMusicInfo('wy', { id: '186016', title: '晴天', artist: '周杰伦', album: '叶惠美' })
assert.deepStrictEqual(mi, { name: '晴天', singer: '周杰伦', albumName: '叶惠美', songmid: '186016', songId: 186016 })
assert.strictEqual(toMusicInfo('kg', { id: 'abc123' }).hash, 'abc123')
assert.strictEqual(toMusicInfo('tx', { id: '0039MnYb0qxYhV' }).mediaMid, '0039MnYb0qxYhV')
console.log('3. toMusicInfo OK')

// 4. 完整脚本链路：inited 捕获、沙箱隔离、utils、musicUrl 应答、音质降级
const log = { info: () => {}, warn: () => {}, error: (...a) => console.log('[error]', ...a) }
const rt = createRuntime({ log })
rt.run(`/**
 * @name 冒烟源
 * @version 0.9.9
 */
const { EVENT_NAMES, on, send, utils } = globalThis.lx
if (typeof require !== 'undefined') throw new Error('sandbox leak: require visible')
if (typeof process !== 'undefined') throw new Error('sandbox leak: process visible')
send(EVENT_NAMES.inited, { status: true, sources: {
  wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
  kg: { name: 'kg', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
} })
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('bad action: ' + action))
  const sig = utils.crypto.md5(info.musicInfo.songmid + '@' + info.type)
  return Promise.resolve('https://example.com/' + source + '/' + info.musicInfo.songmid + '/' + info.type + '?sig=' + sig)
})`)
assert.strictEqual(rt.state.loaded, true)
assert.strictEqual(rt.info.name, '冒烟源')
assert.ok(rt.state.inited?.sources?.wy)

const r1 = await resolveMusicUrl(rt, { source: 'wy', song: { id: '186016', title: '晴天', artist: '周杰伦' }, quality: 'hires' })
assert.strictEqual(r1.quality, '320k') // hires 不支持 → 降档
assert.ok(r1.url.startsWith('https://example.com/wy/186016/320k?sig='))
await assert.rejects(() => resolveMusicUrl(rt, { source: 'tx', song: { id: 'x' }, quality: 'high' }), /未声明音源 tx/)
console.log('4. script pipeline OK ->', r1.url)

// 5. lx.request 语义：字符串 body + 自动 JSON 解析 + raw Buffer + 不跟随重定向
const real = await new Promise((resolve, reject) => {
  httpRequest('https://api.github.com/zen', { headers: { 'User-Agent': 'lx-bridge-test' } }, (err, resp, body) =>
    err ? reject(err) : resolve({ resp, body }),
  )
})
assert.strictEqual(real.resp.statusCode, 200)
assert.ok(typeof real.body === 'string' && real.body.length > 0)
assert.ok(Buffer.isBuffer(real.resp.raw), 'resp.raw 应为 Buffer')
console.log('5. lx.request OK ->', real.body.replace(/\s+/g, ' ').trim())

const red = await new Promise((resolve, reject) => {
  httpRequest('https://httpbin.org/redirect/2', {}, (err, resp) => (err ? reject(err) : resolve(resp)))
})
assert.strictEqual(red.statusCode, 302, '应交付 302 本身（不跟随重定向，与洛雪一致）')
assert.ok(red.headers.location, '应带 location 头')
console.log('6. 302 not followed OK')

const form = await new Promise((resolve, reject) => {
  httpRequest('https://httpbin.org/post', { method: 'POST', form: { a: '1', b: 'zi' } }, (err, resp, body) =>
    err ? reject(err) : resolve({ resp, body }),
  )
})
assert.ok(form.body?.form?.a === '1' && form.body?.form?.b === 'zi', 'form 应被服务端收到（自动 JSON 解析）')
console.log('7. form OK')

rt.dispose()
console.log('ALL SMOKE TESTS PASSED')
