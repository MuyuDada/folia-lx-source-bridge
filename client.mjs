// LX 自定义音源桥 — client 入口（渲染进程）
//
// 两种接法（可同时用，见模组设置）：
//   1. 钩子模式（omni.hooks）：内置音源（网易云/酷狗/QQ…）解析出播放地址后，改用 LX 脚本返回的地址。
//      这也是 LX 自定义源在洛雪里的真实语义——列表用宿主的，URL 换脚本的。
//   2. 独立音源（omni.providers）：注册一个出现在音源切换器里的「LX」音源；
//      搜索代理给脚本支持的内置平台，播放地址一律问脚本。
//
// 两个接口都是 Folium 实验接口，可能随宿主 minor 版本变化；每一路都单独兜错，互不拖垮。

const HOOK_SOURCE_MAP = { netease: 'wy', kugou: 'kg', qq: 'tx', kuwo: 'kw', migu: 'mg' }
const PROVIDER_OF_LX_SOURCE = { wy: 'netease', kg: 'kugou', tx: 'qq' }

const L = (zh, en) => ({ 'zh-CN': zh, en })

export default async function activate(folium) {
  const { log, rpc, events, registries, ui, net, omni, host, experimental } = folium

  // ---------------------------------------------------------------- 设置
  const section = registries.settingsSections.register({
    id: 'lx-source',
    label: L('LX 自定义音源', 'LX custom source'),
    description: L(
      '运行洛雪音乐（LX Music）的自定义源脚本。脚本只负责解析播放地址；歌单与搜索仍来自内置音源。',
      'Runs LX Music custom-source scripts. The script only resolves playback URLs; catalogs stay on the builtin sources.',
    ),
    settings: [
      {
        key: 'enabled',
        type: 'boolean',
        label: L('接管播放地址（钩子模式）', 'Override playback URLs (hook mode)'),
        description: L(
          '内置音源解析出播放地址后，改用 LX 脚本返回的地址',
          'Swap in the URL the LX script returns after the builtin source resolves one',
        ),
        defaultValue: true,
      },
      {
        key: 'quality',
        type: 'select',
        label: L('音质', 'Audio quality'),
        defaultValue: 'high',
        options: [
          { value: 'standard', label: L('标准（128k）', 'Standard (128k)') },
          { value: 'high', label: L('高品（320k）', 'High (320k)') },
          { value: 'lossless', label: L('无损（flac）', 'Lossless (flac)') },
          { value: 'hires', label: L('Hi-Res（flac24bit）', 'Hi-Res (flac24bit)') },
        ],
      },
      {
        key: 'scriptUrl',
        type: 'text',
        label: L('脚本下载地址', 'Script URL'),
        description: L(
          '主进程从这里下载 source.js 并保存；也可以直接把脚本放进数据目录',
          'The main process downloads source.js from here; you can also drop the file into the data folder',
        ),
        placeholder: 'https://…/source.js',
      },
      {
        key: 'providerMode',
        type: 'boolean',
        label: L('注册为独立音源', 'Register a standalone source'),
        description: L(
          '在音源切换器显示「LX」音源；搜索结果代理自脚本支持的内置平台',
          'Show an "LX" entry in the source switcher; search proxies a builtin platform the script supports',
        ),
        defaultValue: true,
      },
    ],
  })

  let values = section.settings.get()
  const settingsUnsubscribe = section.settings.onChange(() => {
    const prev = values
    values = section.settings.get()
    if (values.scriptUrl?.trim() && values.scriptUrl.trim() !== prev.scriptUrl?.trim()) {
      void rpc
        .call('lx.setScriptUrl', { url: values.scriptUrl.trim() })
        .then(next => {
          status = next
          ui.toast(`LX 源脚本已更新：${status.script.name || '(未命名)'}`, { type: 'success' })
        })
        .finally(() => refreshStatus())
    }
    syncProviderMode()
  })

  // ---------------------------------------------------------------- 状态
  let status = null
  const refreshStatus = async () => {
    try {
      status = await rpc.call('lx.status')
    } catch (err) {
      log.error('读取 LX 桥状态失败', err)
    }
    registerProvider()
    return status
  }
  if (host.folium.minor >= 7) {
    try {
      rpc.on('lx.statusChanged', () => refreshStatus())
    } catch {}
  }

  const supportsMusicUrl = lxSource =>
    Boolean(status?.loaded && status.sources?.[lxSource]) &&
    (!Array.isArray(status.sources[lxSource].actions) ||
      status.sources[lxSource].actions.length === 0 ||
      status.sources[lxSource].actions.includes('musicUrl'))

  // 占位地址：钩子只有 1.5s 时限，等不起脚本解析。这里瞬间改写成
  // http://127.0.0.1:<port>/p/<payload>，真正的解析发生在播放器来取流时（main 侧，
  // 带 10 分钟缓存与去重），并同步 fire-and-forget 预热一次。
  const toBase64Url = str => {
    const bytes = new TextEncoder().encode(str)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const placeholderUrl = (lxSource, song, quality) => {
    if (!status?.loaded || !status.proxyPort) return null
    const payload = toBase64Url(
      JSON.stringify({
        source: lxSource,
        quality: quality || values.quality || 'high',
        song: { id: String(song.id), title: song.title ?? '', artist: song.artist ?? '', album: song.album ?? '' },
      }),
    )
    return `http://127.0.0.1:${status.proxyPort}/p/${payload}`
  }
  const prefetch = (lxSource, song, quality) => {
    void rpc
      .call('lx.prefetch', {
        source: lxSource,
        song: { id: song.id, title: song.title ?? '', artist: song.artist ?? '', album: song.album ?? '' },
        quality: quality || values.quality || 'high',
      })
      .catch(() => {})
  }

  // ---------------------------------------------------------------- 接法 1：钩子（纯同步，绝不超时）
  let hookDisposer = null
  try {
    hookDisposer = events.on('omni.audioSourceResolved', ev => {
      if (!values.enabled || !ev.song || ev.song.source == null || ev.song.id == null) return
      const lxSource = HOOK_SOURCE_MAP[ev.song.source]
      if (!lxSource || !supportsMusicUrl(lxSource)) return
      const placeholder = placeholderUrl(lxSource, ev.song, values.quality)
      if (placeholder) ev.url = placeholder
      prefetch(lxSource, ev.song, values.quality)
    })
  } catch (err) {
    log.error('omni.audioSourceResolved 钩子不可用（钩子模式关闭，独立音源不受影响）', err)
  }

  // ---------------------------------------------------------------- 接法 2：独立音源
  let providerHandle = null
  const searchStates = new Map() // query → { cursor, nextOffset }：omni 游标分页 → 偏移分页的适配

  const registerProvider = () => {
    if (providerHandle || !values.providerMode || !status?.loaded) return
    const def = experimental?.['omni.providers']
    if (!def || typeof def.register !== 'function') {
      log.warn('宿主未提供 omni.providers 接口，独立音源不可用')
      return
    }

    // 从脚本支持的音源里挑一个已配置且可搜索的内置平台做搜索代理
    let proxy = null
    try {
      const hosts = omni.listProviders()
      for (const [lxSource, providerId] of Object.entries(PROVIDER_OF_LX_SOURCE)) {
        if (!supportsMusicUrl(lxSource)) continue
        const info = hosts.find(p => p.providerId === providerId)
        if (info?.configured && info.supports?.search) {
          proxy = { lxSource, info }
          break
        }
      }
    } catch {}

    try {
      providerHandle = def.register({
        id: 'lx',
        displayName: status.script.name || 'LX 自定义源',
        shortName: 'LX',
        search: proxy
          ? async (query, { limit, offset }) => {
              let state = searchStates.get(query)
              let cursor
              let consumed = 0
              if (state && offset >= state.nextOffset) {
                cursor = state.cursor
                consumed = state.nextOffset
              } else {
                searchStates.delete(query)
              }
              let page
              try {
                page = await omni.searchSongs(query, { providerId: proxy.info.providerId, cursor, limit })
              } catch (err) {
                searchStates.delete(query)
                if (!cursor) throw err
                page = await omni.searchSongs(query, { providerId: proxy.info.providerId, limit })
                consumed = 0
              }
              const drop = Math.max(0, offset - consumed)
              const items = page.items.slice(drop).map(s => {
                // FoliumSong 本身不带封面；describeSong 是宿主侧的同步缓存读，顺手补齐封面和时长
                let details = null
                try {
                  details = omni.describeSong(s)
                } catch {}
                return {
                  id: `${proxy.lxSource}:${s.id ?? ''}`,
                  title: s.title,
                  artists: s.artist ? s.artist.split(' / ').filter(Boolean) : [],
                  album: s.album ?? undefined,
                  coverUrl: details?.coverUrl ?? undefined,
                  durationMs: details?.durationMs ?? undefined,
                }
              })
              searchStates.set(query, { cursor: page.nextCursor, nextOffset: consumed + page.items.length })
              if (searchStates.size > 32) searchStates.delete(searchStates.keys().next().value)
              return { items, hasMore: page.nextCursor != null, total: page.total ?? undefined }
            }
          : undefined,
        getSong: async compositeId => {
          const sep = compositeId.indexOf(':')
          if (sep < 1) return null
          const lxSource = compositeId.slice(0, sep)
          const songId = compositeId.slice(sep + 1)
          const providerId = PROVIDER_OF_LX_SOURCE[lxSource]
          if (!providerId) return null
          const [res] = await omni.resolveSongs([{ source: providerId, id: songId }])
          if (!res || res.status !== 'found') return null
          const details = omni.describeSong(res.song)
          return {
            id: compositeId,
            title: res.song.title,
            artists: res.song.artist ? res.song.artist.split(' / ').filter(Boolean) : [],
            album: res.song.album ?? undefined,
            coverUrl: details?.coverUrl ?? undefined,
            durationMs: details?.durationMs ?? undefined,
          }
        },
        getAudioUrl: async song => {
          const sep = song.id.indexOf(':')
          if (sep < 1) return null
          const placeholder = placeholderUrl(
            song.id.slice(0, sep),
            {
              id: song.id.slice(sep + 1),
              title: song.title,
              artist: (song.artists ?? []).join(' / '),
              album: song.album ?? '',
            },
            values.quality,
          )
          // 占位地址由 main 侧在播放器取流时解析；这里绝不等待
          return placeholder ? { url: placeholder } : null
        },
        // LX 音乐源脚本不提供歌词/封面（规范里只有 local 源有 lyric/pic），交给宿主默认行为
        getLyrics: async () => null,
      })
      log.info(`已注册独立音源：folium.lx-source-bridge.lx${proxy ? `（搜索代理：${proxy.info.providerId}）` : '（无搜索代理）'} `)
    } catch (err) {
      providerHandle = null
      log.error('注册独立音源失败（钩子模式不受影响）', err)
    }
  }

  const syncProviderMode = () => {
    if (values.providerMode) registerProvider()
    else if (providerHandle) {
      try {
        providerHandle.unregister()
      } catch {}
      providerHandle = null
    }
  }

  // ---------------------------------------------------------------- 命令
  try {
    registries.commands.register({
      id: 'reload-script',
      label: L('重载 LX 音源脚本', 'Reload LX source script'),
      run: async () => {
        status = await rpc.call('lx.reload')
        registerProvider()
        return {
          message: status.loaded
            ? `已加载：${status.script.name || '(未命名脚本)'}（音源：${
                Object.keys(status.sources).join('、') || '无'
              }）`
            : status.fileMissing
              ? '还没有脚本：执行「打开 LX 脚本目录」，把脚本放进去命名为 source.js'
              : '脚本加载失败，详情见模组日志',
        }
      },
    })
    registries.commands.register({
      id: 'open-script-dir',
      label: L('打开 LX 脚本目录', 'Open LX script folder'),
      run: async () => {
        const res = await rpc.call('lx.openScriptDir')
        return { message: res.path }
      },
    })
  } catch (err) {
    log.error('注册命令失败', err)
  }

  // ---------------------------------------------------------------- 启动收尾
  await refreshStatus()
  if (!status?.loaded) {
    const url = String(values.scriptUrl || '').trim()
    if (url) {
      try {
        status = await rpc.call('lx.setScriptUrl', { url })
        registerProvider()
        ui.toast(`LX 源脚本已下载并加载：${status.script.name || url}`, { type: 'success' })
      } catch (err) {
        log.error('下载 LX 源脚本失败', err)
        ui.toast(`下载 LX 源脚本失败：${err?.message ?? err}`, { type: 'error' })
      }
    } else {
      ui.toast('LX 音源桥：尚未加载脚本。请在模组设置里填写脚本地址，或执行「打开 LX 脚本目录」放入脚本', {
        type: 'info',
        durationMs: 8000,
      })
    }
  }

  return () => {
    hookDisposer?.()
    try {
      providerHandle?.unregister()
    } catch {}
    settingsUnsubscribe?.()
  }
}
