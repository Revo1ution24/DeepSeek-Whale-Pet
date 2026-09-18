/* ============================================================================
 * 小鲸鱼桌宠 —— 渲染进程（鲸鱼窗口）
 * 移植自 DSH 原版 WIDGET_JS（lib/index.js 内嵌脚本）并适配 Linux 独立版：
 *   - 余额/配置/位置全部走 preload 桥（window.whaleAPI），不再有 /dsh-whale/* 路由
 *   - 窗口拖拽由主进程轮询光标移动窗口本体；渲染进程负责吸附与位置记忆
 *   - 新增：呼吸动画（CSS）、情绪表情、闲置半透明、预警换图
 *   - 移除：每轮消耗胶囊、滚动条避让（桌面无滚动条）、页面内汉堡菜单（改为独立设置窗口）
 *   - 点击：窗口始终接收事件（不做 OS 级穿透，Linux/XWayland 下不可靠），
 *     鲸鱼本体（isWhaleHit 画布 alpha）之外的点按直接忽略
 * ========================================================================== */
(function () {
  'use strict'
  if (window.__whalePetLoaded) return
  window.__whalePetLoaded = true

  var api = window.whaleAPI
  if (!api) { console.error('[whale-pet] preload bridge missing'); return }

  // Windows：透明点击穿透改用 setIgnoreMouseEvents(forward) 悬停驱动 ——
  // setShape 区域 + 透明层跨屏移动会黑框闪烁、区域错位（图像残损直至不可见），
  // 且外接矩形/像素轮廓仍会挡住透明留白处的桌面按钮。Windows 下窗口无任何区域，
  // 由渲染进程按像素级 alpha 判定悬停交互区；Linux/macOS 沿用 setShape 区域方案。
  var USE_IGNORE = api.platform === 'win32'

  var BASE_PX = 320
  var MIN_SCALE = 0.6
  var MAX_SCALE = 2.5
  var CLICK_SQ = 9
  var ANIM_MS = 700
  var CHANGE_MS = 900
  var BUBBLE_MS = 5000
  var IDLE_MS = 3000

  // ------------------------------------------------------------------ DOM
  var root = document.createElement('div')
  root.className = 'wp-root'
  root.style.setProperty('--wp-base', BASE_PX + 'px')

  var body = document.createElement('div')
  body.className = 'wp-body'
  var breath = document.createElement('div')
  breath.className = 'wp-breath'

  var img = document.createElement('img')
  img.className = 'wp-img'
  img.src = '../assets/DSniang1.png'
  img.alt = 'DeepSeek 余额'
  img.draggable = false

  // 预警徽标（默认隐藏；达到预警额度且开启预警换图时显示）
  var alertBadge = document.createElement('div')
  alertBadge.className = 'wp-alert-badge'
  alertBadge.textContent = '!'

  breath.appendChild(img)
  breath.appendChild(alertBadge)

  var bubbleBox = document.createElement('div')
  bubbleBox.className = 'wp-bubble'
  bubbleBox.innerHTML =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="wp-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="wp-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="wp-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '</svg>'
  var gifEl = document.createElement('img')
  gifEl.className = 'wp-gif'
  gifEl.src = '../assets/rua.gif'
  gifEl.alt = ''
  gifEl.draggable = false
  var gifFailed = false
  gifEl.onerror = function () { gifFailed = true }
  bubbleBox.appendChild(gifEl)

  var textBox = document.createElement('div')
  textBox.className = 'wp-text'
  var labelEl = document.createElement('div')
  labelEl.className = 'wp-label'
  labelEl.textContent = 'DeepSeek 余额'
  var amountEl = document.createElement('div')
  amountEl.className = 'wp-amount'
  var hintEl = document.createElement('div')
  hintEl.className = 'wp-hint'
  textBox.appendChild(labelEl)
  textBox.appendChild(amountEl)
  textBox.appendChild(hintEl)
  bubbleBox.appendChild(textBox)

  var menuBtn = document.createElement('button')
  menuBtn.type = 'button'
  menuBtn.className = 'wp-menu-btn'
  menuBtn.title = '设置'
  menuBtn.innerHTML = '<span></span><span></span><span></span>'
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    api.openMenu()
  })

  body.appendChild(breath)
  body.appendChild(bubbleBox)
  root.appendChild(body)
  root.appendChild(menuBtn)
  document.body.appendChild(root)

  // ------------------------------------------------------------- 状态
  var state = {
    scale: 1,
    h: 'right',
    v: 'bottom',
    posX: null,
    posY: null,
    winW: BASE_PX,
    winH: BASE_PX,
    balance: null,
    currency: 'CNY',
    todayUsage: null,
    isPeak: false,
    status: 'loading',
    message: '',
  }
  var busy = false
  var refreshTimer = null
  var idleCheckTimer = null
  var animId = null
  var shown = null
  var animDelayTimer = null
  var settleTimer = null
  var drag = null
  var bubbleShown = false
  var bubbleTimer = null
  var bubbleRandomActive = false
  var bubbleRandomLines = null
  var bubbleSwapTimer = null
  var hintFadeTimer = null
  var gifFadeTimer = null
  var lastHintText = null
  var soundOn = true
  var soundVol = 0.8
  var soundSet = 'duck'
  var peakMode = 'default'
  var peakText = true
  var bubbleOn = true
  var bubbleIntervalMs = 120000
  var bubbleIntervalTimer = null
  var idleFade = true
  var refreshIntervalMs = 60000
  var threshold = 10
  var alertImage = false
  var mainImgPath = 'assets/DSniang1.png'
  var alertImgPath = 'assets/DSniang03.png'
  var bubbleTextOk = 'DeepSeek 余额'
  var bubbleTextLow = '余额预警'
  var textColorOk = ''
  var textColorLow = ''
  var peakTextOff = ''
  var peakTextOn = ''
  var pressSound = ''
  var releaseSound = ''
  var customGroups = null
  var currentImgSrc = ''
  var lastPointerMoveAt = Date.now()
  var flipped = false
  // 显示器列表（{id, bounds, workArea}）：左右朝向判定与四角吸附都按「鲸鱼当前
  // 所在的那一块显示器」计算，而不是所有显示器的包围盒 —— 多屏时包围盒中心会
  // 落在某一侧屏幕内，导致另一块屏幕上的左右判定整体反向（朝向看着别扭）。
  var displays = []
  var SNAP_DIST = 90 // 四角吸附：松手时窗口位置与角点的最大距离（px）

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

  // ------------------------------------------------------------- 气泡
  function fmt(balance, currency) {
    var num = Number(balance)
    var fixed = isFinite(num) ? num.toFixed(2) : '--'
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
  }

  var BUBBLE_STYLE_CLASS = { A: 'wp-label', B: 'wp-amount', P: 'wp-period', C: 'wp-hint' }
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
  function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null] }

  function buildGroup1() {
    var peak = !!state.isPeak
    var offText = peakTextOff || '空闲时段'
    var peakTextStr = peakTextOn || '高峰时段'
    if (!peakTextOff && !peakTextOn) {
      if (peakMode === 'liangwen') { offText = '梁文谷'; peakTextStr = '梁文峰' }
      else if (peakMode === 'qiangqiang') { offText = '!?谷谷?!'; peakTextStr = '!?峰峰?!' }
    }
    // 峰谷：恢复原来的多行展示（当前时间段 / 高峰·空闲 / 今日已用）
    if (!peakText) {
      return [{ t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' }]
    }
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peak ? peakTextStr : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
      { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },
    ]
  }

  // 随机台词池完全来自 ~/.config/whale-pet/lines.json（含默认值，主进程首次
  // 自动生成文件）；渲染进程不再硬编码台词。
  var poolCache = null

  function buildCustomPool() {
    var groups = customGroups && Array.isArray(customGroups.groups) ? customGroups.groups : []
    var pool = []
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i]
      var weight = Number(g && g.weight)
      if (!isFinite(weight) || weight <= 0) continue
      if (g.type === 'balance') {
        pool.push({ w: weight, lines: buildGroup1 })
      } else if (g.type === 'gif') {
        pool.push({ w: weight, lines: function () { return { gif: true } } })
      } else if (g.text && String(g.text).trim()) {
        // 新格式：单条台词独立成组，气泡每次只弹这一条（避免多行同时输出）
        pool.push({ w: weight, lines: (function (grp) {
          return function () { return singleCenter(grp.style, grp.text, grp.color, grp.wrap) }
        })(g) })
      } else if (g.lines && g.lines.length) {
        // 兼容旧格式（一组多条 lines）：随机抽 1 条
        pool.push({ w: weight, lines: (function (grp) {
          return function () {
            var l = grp.lines[Math.floor(Math.random() * grp.lines.length)]
            return singleCenter(l.style, l.text, l.color, l.wrap)
          }
        })(g) })
      }
    }
    if (!pool.length) pool = [{ w: 45, lines: buildGroup1 }]
    return pool
  }

  function pickRandomLines() {
    if (!poolCache) poolCache = buildCustomPool()
    var total = 0
    for (var i = 0; i < poolCache.length; i++) total += poolCache[i].w
    var r = Math.random() * total
    for (var i = 0; i < poolCache.length; i++) {
      r -= poolCache[i].w
      if (r < 0) return poolCache[i].lines()
    }
    return poolCache[poolCache.length - 1].lines()
  }

  function applyBubbleLines(lines) {
    if (lines && lines.gif) {
      if (gifFailed) {
        lines = singleCenter('A', pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']), '', true)
      } else {
        if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
        gifEl.style.display = 'block'
        gifEl.style.opacity = ''
        labelEl.style.display = 'none'
        amountEl.style.display = 'none'
        hintEl.style.display = 'none'
        return
      }
    }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    var els = [labelEl, amountEl, hintEl]
    for (var i = 0; i < 3; i++) {
      var el = els[i]
      var ln = lines && lines[i]
      if (ln) {
        el.style.display = ''
        el.className = (BUBBLE_STYLE_CLASS[ln.s] || 'wp-label') + (ln.w ? ' wp-wrap' : '')
        el.textContent = ln.t
        el.style.color = ln.c || ''
      } else {
        el.style.display = 'none'
        el.textContent = ''
        el.style.color = ''
      }
    }
  }

  function setHint(text) {
    if (text === lastHintText) return
    var first = lastHintText === null
    lastHintText = text
    if (first || !bubbleShown) {
      hintEl.textContent = text
      return
    }
    hintEl.style.transition = 'opacity .18s ease'
    hintEl.style.opacity = '0'
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null
      hintEl.textContent = text
      hintEl.style.opacity = '1'
      setTimeout(function () {
        hintEl.style.transition = ''
        hintEl.style.opacity = ''
      }, 220)
    }, 190)
  }

  function swapBubbleContent(applyFn) {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    textBox.style.transition = 'opacity .18s ease'
    textBox.style.opacity = '0'
    bubbleSwapTimer = setTimeout(function () {
      bubbleSwapTimer = null
      applyFn()
      textBox.style.opacity = '1'
      setTimeout(function () {
        textBox.style.transition = ''
        textBox.style.opacity = ''
      }, 220)
    }, 190)
  }

  function restoreBubbleLines() {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    lastHintText = null
    textBox.style.transition = ''
    textBox.style.opacity = ''
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    labelEl.style.display = ''
    labelEl.className = 'wp-label'
    labelEl.style.color = ''
    setStateLabel()
    amountEl.style.display = ''
    amountEl.className = 'wp-amount'
    amountEl.style.color = ''
    hintEl.style.display = ''
    hintEl.className = 'wp-hint'
    hintEl.style.color = ''
    render()
  }

  function showBubble() {
    if (!bubbleOn) return
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    bubbleShown = true
    bubbleRandomActive = false
    restoreBubbleLines()
    bubbleBox.classList.add('wp-bubble-open')
    reportShape()
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  // 自动随机台词：每 bubbleInterval 秒弹一次「随机台词」气泡（非余额内容）。
  // 点击气泡切换/关闭行为不变；自动触发时直接展示随机台词段。
  function showRandomBubble() {
    // 守卫：关闭气泡、拖拽中、已有气泡展开（用户正在看）时不打断自动弹出
    if (!bubbleOn) return
    if (bubbleShown) return
    if (drag && drag.active) return
    if (state.status === 'error') return // 出错时不打扰
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    bubbleShown = true
    bubbleRandomActive = true
    bubbleRandomLines = pickRandomLines()
    applyBubbleLines(bubbleRandomLines)
    bubbleBox.classList.add('wp-bubble-open')
    reportShape()
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    textBox.style.transition = ''
    textBox.style.opacity = ''
    hintEl.style.transition = ''
    hintEl.style.opacity = ''
    bubbleRandomActive = false
    bubbleRandomLines = null
    bubbleShown = false
    bubbleBox.classList.remove('wp-bubble-open')
    reportShape()
    gifFadeTimer = setTimeout(function () {
      gifFadeTimer = null
      gifEl.style.display = 'none'
    }, 240)
  }

  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!bubbleShown) return
    if (bubbleRandomActive) {
      hideBubble()
    } else {
      bubbleRandomActive = true
      bubbleRandomLines = pickRandomLines()
      swapBubbleContent(function () { applyBubbleLines(bubbleRandomLines) })
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
    }
  })

  // ------------------------------------------------------------- 渲染刷新
  function animateAmount(from, to, currency, duration) {
    if (animId) cancelAnimationFrame(animId)
    if (from === null || !isFinite(from)) from = to
    if (from === to) {
      shown = to
      amountEl.textContent = fmt(to, currency)
      return
    }
    var startTime = null
    function step(ts) {
      if (startTime === null) startTime = ts
      var t = Math.min(1, (ts - startTime) / duration)
      var eased = 1 - Math.pow(1 - t, 3)
      var val = from + (to - from) * eased
      amountEl.textContent = fmt(val, currency)
      if (t < 1) {
        animId = requestAnimationFrame(step)
      } else {
        animId = null
        shown = to
        amountEl.textContent = fmt(to, currency)
      }
    }
    animId = requestAnimationFrame(step)
  }

  function render() {
    var amount, hint
    if (state.status === 'error') {
      amount = shown !== null ? fmt(shown, state.currency) : '--'
      hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试'
    } else if (state.balance === null) {
      amount = shown !== null ? fmt(shown, state.currency) : '…'
      hint = '加载中…'
    } else {
      amount = shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency)
      hint = '今日已用 ' + (state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--')
    }
    amountEl.textContent = amount
    if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines)
    } else {
      setHint(hint)
      setStateLabel()
    }
    updateHeroImage()
  }

  function isLowBalance() {
    return state.status === 'ok' && state.balance !== null && isFinite(state.balance) &&
      state.balance >= 0 && state.balance < threshold
  }

  // 气泡第一行：余额充足/预警 两套自定义文案（限 20 字符，config 已消毒）
  function setStateLabel() {
    var low = isLowBalance()
    var t = low ? (bubbleTextLow || 'DeepSeek 余额') : (bubbleTextOk || 'DeepSeek 余额')
    var c = low ? textColorLow : textColorOk
    if (labelEl.textContent !== t) labelEl.textContent = t
    if (labelEl.style.color !== c) labelEl.style.color = c
  }

  // 自定义随机台词/动图池（~/.config/whale-pet/lines.json，含全部默认值）
  function applyCustom(data) {
    customGroups = data && Array.isArray(data.groups) ? data : null
    poolCache = null // 池变化 → 重建
    var gif = data && typeof data.gif === 'string' && data.gif.trim() ? data.gif.trim() : ''
    try {
      var want = gif ? resolveImgPath(gif) : '../assets/rua.gif'
      var cur = gifEl.getAttribute('src')
      if (cur !== want) gifEl.setAttribute('src', want)
    } catch (err) {}
  }

  function resolveImgPath(p) {
    var s = String(p || '').trim()
    if (!s) return ''
    // http/https/file 或绝对路径原样使用
    if (/^(https?:|file:)/.test(s)) return s
    if (s.charAt(0) === '/') return 'file://' + s
    // 相对路径基于应用根目录：renderer/pet.html 位于 renderer/ 下 → ../assets/
    return s.indexOf('assets/') === 0 ? '../' + s : '../' + s
  }

  // 主图/预警图二选一：预警换图开启且余额低于阈值 → 预警图；否则主图
  function updateHeroImage() {
    var low = alertImage && isLowBalance()
    var want = low ? resolveImgPath(alertImgPath) : resolveImgPath(mainImgPath)
    if (want && want !== currentImgSrc) {
      currentImgSrc = want
      img.src = want
      setupHitTest(want)
    }
    alertBadge.classList.toggle('wp-alert-badge-show', !!low)
  }

  async function refresh(manual) {
    if (busy) return
    busy = true
    if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null }
    if (manual || state.balance === null) { state.status = 'loading'; render() }
    try {
      var data = await api.getBalance()
      if (data && data.ok) {
        var nb = Number(data.totalBalance)
        var nc = String(data.currency || 'CNY')
        var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
        var currencyChanged = state.currency !== null && nc !== state.currency
        state.balance = nb
        state.currency = nc
        state.message = ''
        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
        state.isPeak = !!data.isPeak
        if (changed && !currencyChanged) {
          if (!manual) {
            showBubble()
            state.status = 'changing'
            if (animDelayTimer) clearTimeout(animDelayTimer)
            animDelayTimer = setTimeout(function () {
              animDelayTimer = null
              animateAmount(shown, nb, nc, ANIM_MS)
            }, 300)
            if (settleTimer) clearTimeout(settleTimer)
            settleTimer = setTimeout(function () {
              settleTimer = null
              if (state.status === 'changing') { state.status = 'ok'; render() }
            }, CHANGE_MS + 300)
          } else {
            animateAmount(shown, nb, nc, ANIM_MS)
            state.status = 'ok'
            render()
          }
        } else {
          if (animId === null) shown = nb
          state.status = 'ok'
          render()
        }
      } else {
        state.status = 'error'
        state.message = (data && data.error) ? String(data.error) : '获取失败'
        render()
      }
    } catch (err) {
      state.status = 'error'
      state.message = '获取失败'
      render()
    } finally {
      busy = false
    }
  }

  // ------------------------------------------------------------- 位置与吸附
  async function initPosition() {
    var wa = await api.getWorkArea()
    var bd = await api.getDisplayBounds()
    var cfg = await api.getConfig()
    var x, y
    if (typeof cfg.posX === 'number' && typeof cfg.posY === 'number') {
      // 用与拖拽一致的钳制：贴左/贴顶的记忆位置（负坐标）重启后仍保持贴边
      var p = settlePos(cfg.posX, cfg.posY, bd, wa)
      x = p.x
      y = p.y
    } else {
      x = wa.x + wa.width - state.winW // 默认右下角
      y = wa.y + wa.height - state.winH
      advancePos(x, y)
    }
    await api.setWindowPos(x, y)
  }

  function advancePos(x, y) {
    state.posX = x
    state.posY = y
    updateAnchor()
  }

  // 可见鲸鱼在窗口内的矩形（CSS px = DIP，含镜像）：贴边钳制的唯一依据
  // - 用 offset*（布局盒）而非 getBoundingClientRect，避免呼吸动画 transform 抖动
  // - 镜像（.wp-left）时图形贴窗口左缘 → 矩形整体翻转，左右贴边方向自动适配
  // - 有 alpha 包围盒时按可见部分收缩（图片自带的透明留白不计入），否则退回图片框
  // flip 作为参数传入：四角吸附需要在不改动当前朝向的前提下预演两种朝向的几何
  function fishRectFor(flip) {
    var x = img.offsetLeft, y = img.offsetTop, w = img.offsetWidth, h = img.offsetHeight
    if (!(w > 0) || !(h > 0)) return null
    if (hitBBox) {
      var vx = x + w * hitBBox.x0
      var vy = y + h * hitBBox.y0
      w = w * (hitBBox.x1 - hitBBox.x0)
      h = h * (hitBBox.y1 - hitBBox.y0)
      x = vx
      y = vy
    }
    if (flip) x = state.winW - (x + w)
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
  }

  function fishRect() { return fishRectFor(flipped) }

  // 位置钳制：可见图形的四条边都能贴到屏幕边（左/上允许负坐标，把图片留白推出屏幕）。
  // 与主进程拖拽钳制同一套规则（左右按显示器边界、底部按工作区不藏任务栏）。
  function clampPos(x, y, bd, wa) {
    var fr = fishRect()
    if (!fr) {
      var headRoom = Math.round(state.winH * 0.4055)
      return {
        x: clamp(x, bd.x - headRoom, Math.max(bd.x, bd.x + bd.width - state.winW)),
        y: clamp(y, bd.y - headRoom, Math.max(wa.y, wa.y + wa.height - state.winH)),
      }
    }
    return {
      x: clamp(x, bd.x - fr.x, Math.max(bd.x, bd.x + bd.width - (fr.x + fr.w))),
      y: clamp(y, bd.y - fr.y, Math.max(wa.y, wa.y + wa.height - (fr.y + fr.h))),
    }
  }

  // 定位收敛（两遍）：镜像方向会随窗口跨过屏幕中线而切换，而镜像后可见图形在窗口
  // 内的左右位置正好相反 —— 先按当前方向钳制，切换方向后再按新矩形复钳一次，
  // 否则「拖到右缘松手 → 鲸鱼翻到另一侧 → 一截被屏幕切掉」。两遍在真实窗口尺寸下
  // 必然收敛（钳制后的位置不会跨回中线），不做循环以免来回跳。
  function settlePos(x, y, bd, wa) {
    var a = clampPos(x, y, bd, wa)
    advancePos(a.x, a.y)
    var b = clampPos(a.x, a.y, bd, wa)
    if (b.x !== a.x || b.y !== a.y) advancePos(b.x, b.y)
    return b
  }

  // 换图/探针就绪后按最新的可见范围收紧位置（拖拽中不动，由主进程引擎接管）
  async function reclampPos() {
    if (drag && drag.active) return
    try {
      var bd = await api.getDisplayBounds()
      var wa = await api.getWorkArea()
      var wasX = state.posX
      var wasY = state.posY
      var p = settlePos(wasX, wasY, bd, wa)
      if (p.x === wasX && p.y === wasY) return // 位置无需收紧（settlePos 已同步 state）
      await api.setWindowPos(p.x, p.y)
      reportShape()
    } catch (err) {}
  }

  // 拉取显示器列表（每次拖拽落定前刷新，插拔显示器后也能立刻生效）。
  // 取不到时退化为「把整个虚拟桌面当作一块屏幕」，行为与旧版一致（不会失效）。
  async function refreshDisplays() {
    try {
      var list = await api.getDisplays()
      if (list && list.length) { displays = list; return }
    } catch (err) {}
    if (displays.length) return
    try {
      var bd = await api.getDisplayBounds()
      displays = [{ id: 0, bounds: bd, workArea: bd }]
    } catch (err) {}
  }

  // 鲸鱼当前所在的那一块显示器（窗口中心落在哪块上；都不在则取最近的）
  function displayAt(x, y) {
    if (!displays.length) return null
    var cx = x + state.winW / 2
    var cy = y + state.winH / 2
    var best = null
    var bestDist = Infinity
    for (var i = 0; i < displays.length; i++) {
      var b = displays[i].bounds
      if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) return displays[i]
      var dx = cx - (b.x + b.width / 2)
      var dy = cy - (b.y + b.height / 2)
      var dist = dx * dx + dy * dy
      if (dist < bestDist) { bestDist = dist; best = displays[i] }
    }
    return best
  }

  function setFlipped(v) {
    if (v === flipped) return
    flipped = v
    root.classList.toggle('wp-left', flipped)
    reportShape() // 镜像后形状需随之镜像
  }

  // 方向感知锚点：窗口中心在「当前所在那块显示器」的左半 → 鲸鱼贴窗口左缘
  // （水平镜像）→ 可触及该屏左边缘；右半则相反（不镜像，贴右缘）。
  // 判定基准必须是单块显示器：旧实现用所有显示器的包围盒中心，多屏时该中心往往
  // 落在另一块屏内，于是本屏的左右判定被整体判反 —— 就是「朝向逻辑有点奇怪」。
  function updateAnchor() {
    var d = displayAt(state.posX, state.posY)
    if (!d) return
    var centerX = d.bounds.x + d.bounds.width / 2
    setFlipped(state.posX + state.winW / 2 < centerX)
  }

  // ---------- 屏幕四角吸附 ----------
  // 左角用镜像朝向（鲸鱼贴窗口左缘）、右角用非镜像朝向；上角按显示器上边界、
  // 下角按工作区下沿（不藏任务栏），与贴边钳制同一套几何规则。
  function cornerTargets(d) {
    var b = d.bounds
    var wa = (d.workArea && d.workArea.width > 0) ? d.workArea : d.bounds
    var out = []
    var flips = [true, false] // true = 左角（镜像）
    for (var i = 0; i < 2; i++) {
      var flip = flips[i]
      var fr = fishRectFor(flip)
      if (!fr) continue
      var cx = flip ? (b.x - fr.x) : (b.x + b.width - (fr.x + fr.w))
      out.push({ x: cx, y: b.y - fr.y, flip: flip }) // 上角
      out.push({ x: cx, y: wa.y + wa.height - (fr.y + fr.h), flip: flip }) // 下角
    }
    return out
  }

  // 松手位置距某个角足够近 → 返回该角的吸附位置（含朝向）；否则返回 null
  function snapCorner(x, y, d) {
    var list = cornerTargets(d)
    var best = null
    for (var i = 0; i < list.length; i++) {
      var t = list[i]
      var dist = Math.max(Math.abs(t.x - x), Math.abs(t.y - y))
      if (dist <= SNAP_DIST && (!best || dist < best.dist)) {
        best = { x: t.x, y: t.y, flip: t.flip, dist: dist }
      }
    }
    return best
  }

  // ---------- 透明点击穿透：窗口裁剪为鲸鱼/气泡/按钮区域 ----------
  // 用布局盒（offset*，不含动画 transform）计算窗口内矩形，其余区域点击
  // 不落在窗口上 → 自然穿透到下方桌面/窗口。换图、开合气泡、缩放后重报。
  // 判定体 = 「看到什么就挡什么」：鲸鱼取 alpha 可见包围盒、气泡按 SVG 实际
  // 绘制范围裁剪，图片/气泡自带的透明留白不再参与判定。
  // 气泡 SVG viewBox 0 0 1026 700（含描边与尾巴）的归一化可见包围盒，
  // 与 pet.js 的 bubbleBox path/ellipse 几何对应 —— 若改 SVG 需同步。
  var BUBBLE_VIS = { x0: 0.07, x1: 0.815, y0: 0.01, y1: 0.96 }

  function reportShape() {
    // Windows：窗口无区域（悬停穿透，见 pet:ignore-mouse），不再上报形状
    if (USE_IGNORE) return
    // 拖拽中不动窗口形状：形状锚定在窗口内部、随窗口一起平移，此刻无需重设；
    // 移动过程中 SetWindowRgn 是 Windows 透明窗口「拖出黑框」的根因之一。
    if (drag && drag.active) return
    try {
      var pad = 2
      var W = state.winW, H = state.winH
      var rects = []
      var p = function (x, y, w, h) {
        // 钳制到窗口范围内（shape 仅接受窗口内部区域）
        var x0 = Math.max(0, x), y0 = Math.max(0, y)
        var x1 = Math.min(W, x + w), y1 = Math.min(H, y + h)
        if (x1 > x0 && y1 > y0) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
      }
      var w = img.offsetWidth
      if (w > 0) {
        // 鲸鱼判定体 = 像素级 alpha 轮廓（见 maskRects，发丝镂空一并保留），
        // 完完全全贴合图像边缘 —— 拖动/点击只有在鲸鱼可见像素上才生效。
        // 判定体积曾用外接矩形：透明角落整块挡鼠标是「判定体过大」的根因。
        var mr = maskRects()
        if (mr && mr.length) {
          for (var ri = 0; ri < mr.length; ri++) p(mr[ri].x, mr[ri].y, mr[ri].w, mr[ri].h)
        } else {
          // 像素轮廓未就绪（图片尚未探针完成）→ 退化为可见外接盒，保证可点
          var vx = img.offsetLeft, vy = img.offsetTop, vw = w, vh = img.offsetHeight
          if (hitBBox) {
            vx += w * hitBBox.x0
            vy += img.offsetHeight * hitBBox.y0
            vw = w * (hitBBox.x1 - hitBBox.x0)
            vh = img.offsetHeight * (hitBBox.y1 - hitBBox.y0)
          }
          p(vx, vy, vw, vh)
        }
      }
      if (bubbleShown) {
        var bw = bubbleBox.offsetWidth
        if (bw > 0) {
          var bh = bubbleBox.offsetHeight
          // 气泡判定体 = 可见气泡形状（含描边/尾巴），四角透明区不再整块挡鼠标
          p(bubbleBox.offsetLeft + Math.round(bw * BUBBLE_VIS.x0) - pad,
            bubbleBox.offsetTop + Math.round(bh * BUBBLE_VIS.y0) - pad,
            Math.round(bw * (BUBBLE_VIS.x1 - BUBBLE_VIS.x0)) + pad * 2,
            Math.round(bh * (BUBBLE_VIS.y1 - BUBBLE_VIS.y0)) + pad * 2)
        }
      }
      var m = menuBtn.offsetWidth
      if (m > 0) p(menuBtn.offsetLeft - 4, menuBtn.offsetTop - 4, m + 8, menuBtn.offsetHeight + 8)
      if (flipped) {
        // 水平镜像：把矩形按窗口宽度翻转
        for (var i = 0; i < rects.length; i++) rects[i].x = W - (rects[i].x + rects[i].w)
      }
      // 空 shape 在 Windows 上会使整个窗口从合成中消失且不可点击。
      // 兜底：任何时刻至少保留一个覆盖鲸鱼区的矩形，绝不上报空数组。
      if (rects.length === 0) rects.push({ x: 0, y: 0, w: W, h: H })
      api.setShape(rects)
    } catch (err) {}
  }

  async function setScale(v) {
    console.log('[diag] setScale called next=' + v + ' current=' + state.scale)
    var next = Math.round(clamp(Number(v), MIN_SCALE, MAX_SCALE) * 10) / 10
    if (next === state.scale) return
    var oldW = state.winW, oldH = state.winH
    var newW = Math.round(BASE_PX * next)
    var newH = newW
    // 固定鲸鱼右下角（无镜像翻转，锚点唯一）
    var fixX = state.posX + oldW
    var fixY = state.posY + oldH
    state.scale = next
    // 先请求主进程真实窗口尺寸，再据此设定 CSS 视觉尺寸：
    // 碰撞箱（点击区/拖拽）以窗口真实 DIP 尺寸为准，CSS 仅做等比视觉缩放，
    // 二者必须同源 —— 否则 Linux/Wayland 下 CSS 像素与窗口 DIP 比例偏差，
    // 会出现「视觉缩小、碰撞箱未缩小」（右/下/上空气墙）。
    var rb = await api.resizeWindow(newW, newH)
    var realW = (rb && rb.width > 0) ? rb.width : newW
    console.log('[diag] resizeWindow returned ' + (rb ? JSON.stringify(rb) : 'null') + ' -> realW=' + realW)
    var realH = (rb && rb.height > 0) ? rb.height : newH
    root.style.setProperty('--wp-base', realW + 'px')
    state.winW = realW
    state.winH = realH
    var x = fixX - realW
    var y = fixY - realH
    var d2 = await api.getDisplayBounds()
    var wa2 = await api.getWorkArea()
    // 与拖拽引擎同一套钳制（按可见图形矩形，而非固定的 40.55% 留白估算）
    var fit = settlePos(x, y, d2, wa2)
    x = fit.x
    y = fit.y
    var rp = await api.setWindowPos(x, y)
    if (rp && isFinite(rp.x) && isFinite(rp.y)) { x = Math.round(rp.x); y = Math.round(rp.y); advancePos(x, y) }
    api.setConfig({ scale: next, posX: x, posY: y })
    reportShape()
  }

  // ------------------------------------------------------------- 命中测试
  var hitCanvas = null
  var hitReady = false
  // 逐像素 alpha 行段（610 空间，见 rowRunAlpha）：窗口判定体积据此生成，
  // 完全贴合图像边缘（发丝镂空也跟随）；探针就绪后填充
  var hitMask = null
  // 图形 alpha 包围盒（0-1 归一化，见 alphaBBox()）。初值 = 内置素材 DSniang1.png
  // 的实测留白（左 45/610、上 10/610），供探针就绪前的定位使用；探针加载后按
  // 实际图片（含用户上传图）重新计算覆盖。
  var hitBBox = { x0: 45 / 610, y0: 10 / 610, x1: 1, y1: 1 }

  // 可见图形的 alpha 包围盒：图片自带透明留白（如 DSniang1 左 7.4%/上 1.6%），
  // 贴边钳制必须按「肉眼可见的鲸鱼」而非图片框，否则贴到边上时视觉上差一截
  function alphaBBox(ctx, n) {
    try {
      var d = ctx.getImageData(0, 0, n, n).data
      var x0 = n, y0 = n, x1 = -1, y1 = -1
      for (var y = 0; y < n; y++) {
        for (var x = 0; x < n; x++) {
          if (d[(y * n + x) * 4 + 3] > 10) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      if (x1 < 0) return null
      return { x0: x0 / n, y0: y0 / n, x1: (x1 + 1) / n, y1: (y1 + 1) / n }
    } catch (err) { return null }
  }

  // 逐像素 alpha 扫描为「每行若干不透明段」（610 源像素坐标系）：窗口判定体
  // 完全跟随图像边缘（发丝间隙等镂空也保留），不再用外接矩形 —— 看到什么挡什么
  function rowRunAlpha(ctx, n) {
    var d = null
    try { d = ctx.getImageData(0, 0, n, n).data } catch (err) { return null }
    var rows = new Array(n)
    for (var y = 0; y < n; y++) {
      var runs = null
      var runStart = -1
      var off = y * n * 4
      for (var x = 0; x <= n; x++) {
        var opaque = false
        if (x < n) { opaque = d[off + x * 4 + 3] > 10 }
        if (opaque && runStart < 0) runStart = x
        else if (!opaque && runStart >= 0) {
          if (!runs) runs = []
          runs.push(runStart, x)
          runStart = -1
        }
      }
      rows[y] = runs
    }
    return rows
  }

  // 把像素级 alpha 段（610 空间）映射到窗口坐标并合并成矩形（纵向合并相邻
  // 行 x 范围相同的段，把上百条窄条压成少量矩形，供 setShape 使用）
  function maskRects() {
    var im = img.offsetLeft, iw = img.offsetWidth, ih = img.offsetHeight
    if (!(iw > 0) || !(ih > 0) || !hitMask) return null
    var out = []
    var open = []
    for (var yS = 0; yS < 610; yS++) {
      var y0 = im + Math.floor(yS * ih / 610)
      var y1 = im + Math.floor((yS + 1) * ih / 610)
      if (y1 <= y0) y1 = y0 + 1
      var row = hitMask[yS]
      var xs = []
      if (row) {
        for (var k = 0; k < row.length; k += 2) {
          var x0 = im + Math.floor(row[k] * iw / 610)
          var x1 = im + Math.ceil(row[k + 1] * iw / 610)
          xs.push([x0, x1])
        }
      }
      // 本行仍在延续的段 → 留在 open；否则收尾为矩形
      var next = []
      for (var j = 0; j < open.length; j++) {
        var s = open[j]
        var keep = false
        for (var m = 0; m < xs.length; m++) {
          if (xs[m][0] === s.x0 && xs[m][1] === s.x1) { keep = true; break }
        }
        if (keep) next.push(s)
        else out.push({ x: s.x0, y: s.y0, w: s.x1 - s.x0, h: y0 - s.y0 })
      }
      open = next
      // 开始新的段（重复的 x 范围不重复入列）
      for (var m2 = 0; m2 < xs.length; m2++) {
        var found = false
        for (var j2 = 0; j2 < open.length; j2++) {
          if (open[j2].x0 === xs[m2][0] && open[j2].x1 === xs[m2][1]) { found = true; break }
        }
        if (!found) open.push({ x0: xs[m2][0], x1: xs[m2][1], y0: y0 })
      }
    }
    for (var r = 0; r < open.length; r++) {
      var s2 = open[r]
      out.push({ x: s2.x0, y: s2.y0, w: s2.x1 - s2.x0, h: im + ih - s2.y0 })
    }
    return out
  }

  function setupHitTest(src) {
    try {
      var probe = new Image()
      hitReady = false // 探针重载期间：命中测试放宽为「全命中」，保证可点击
      probe.onload = function () {
        try {
          hitCanvas = hitCanvas || document.createElement('canvas')
          hitCanvas.width = 610
          hitCanvas.height = 610
          var ctx = hitCanvas.getContext('2d')
          ctx.drawImage(probe, 0, 0, 610, 610)
          hitReady = true
          hitBBox = alphaBBox(ctx, 610)
          hitMask = rowRunAlpha(ctx, 610) // 像素级轮廓：判定体积贴合图像边缘
          reclampPos() // 换图后可见范围可能变化 → 按新矩形重新收紧位置
        } catch (err) {}
      }
      probe.onerror = function () { /* hitReady 保持 false → 全命中，可点击优先 */ }
      probe.src = src || '../assets/DSniang1.png'
    } catch (err) {}
  }

  function isWhaleHit(e) {
    if (!hitCanvas || !hitReady) return true
    try {
      var r = img.getBoundingClientRect()
      if (!r || r.width <= 0 || r.height <= 0) return false
      var lx = (e.clientX - r.left) / r.width * 610
      var ly = (e.clientY - r.top) / r.height * 610
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
      if (flipped) lx = 610 - lx // 镜像后坐标映射需反转
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
      return data[3] > 10
    } catch (err) {
      return true
    }
  }

  // 是否在「可点击区域」内（鲸鱼盒 / 气泡盒 / 按钮盒）—— 用于显示汉堡按钮：
  // 鼠标从鲸鱼滑向按钮时若已离开鲸鱼 alpha，仍应保持按钮可见（避免三横线消失）。
  function inClickable(e) {
    try {
      var r = img.getBoundingClientRect()
      if (r && e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6) return true
      var m = menuBtn.getBoundingClientRect()
      if (m && e.clientX >= m.left - 6 && e.clientX <= m.right + 6 && e.clientY >= m.top - 6 && e.clientY <= m.bottom + 6) return true
      if (bubbleShown) {
        var b = bubbleBox.getBoundingClientRect()
        if (b && e.clientX >= b.left - 6 && e.clientX <= b.right + 6 && e.clientY >= b.top - 6 && e.clientY <= b.bottom + 6) return true
      }
      return isWhaleHit(e)
    } catch (err) { return isWhaleHit(e) }
  }

  // ---------- Windows 悬停判定（USE_IGNORE） ----------
  // 窗口无区域时靠 mousemove 判定是否落在交互区（鲸鱼像素 / 气泡 / 按钮矩形）：
  // 悬停其上 → 由 setIgnoreMouseEvents(false) 接收点击；其余 → 穿透到桌面
  // （透明留白、鲸鱼侧/上缘完全不再阻挡桌面按钮 —— 判定体 = 像素级 alpha）。
  function overBox(e, el, pad) {
    try {
      var r = el.getBoundingClientRect()
      var p = pad || 4
      return r && e.clientX >= r.left - p && e.clientX <= r.right + p && e.clientY >= r.top - p && e.clientY <= r.bottom + p
    } catch (err) { return false }
  }

  function overInteractive(e) {
    if (overBox(e, menuBtn, 4)) return true
    if (bubbleShown && overBox(e, bubbleBox, 4)) return true
    return isWhaleHit(e)
  }

  // 幂等切换：只有状态变化才发 IPC（forward 固定 true → move 持续转发供悬停判定）
  var ignoreMouse = null
  function applyIgnore(v) {
    if (!USE_IGNORE) return
    if (v === ignoreMouse) return
    ignoreMouse = v
    api.setIgnoreMouse(!!v)
  }

  // ------------------------------------------------------------- 指针交互
  // 拖拽：窗口移动全部由主进程拖拽引擎完成（单一权威，见 main.js 拖拽引擎注释）
  // 渲染进程只上报两类原始数据：位移增量（e.movementX/Y）与光标绝对坐标，
  // 自身绝不做任何位移运算（client/screen 与窗口位置耦合，曾导致抽搐与飞移）
  // setPointerCapture 保证窗口外松手不掉拖。
  //
  // 光标绝对坐标（渲染进程 CSS 像素空间）：e.screenX/screenY 是 OS 下发的真实值，
  // 单轴为 0 是真实边界坐标（光标贴屏幕左缘/上缘）—— 必须原样使用，逐轴判断
  // 「非零才可用」会在贴左/贴顶的最后几像素处退化成合成值。
  // 仅当两轴都为 0（XWayland 下 OS 不下发绝对坐标）才用「窗口位置 + client 偏移」
  // 合成：合成值以窗口自身位置为输入，主进程按绝对锚点移动窗口时构成反馈回路
  // （贴边抖动/回弹），故只在拿不到原生坐标时兜底
  function absPoint(e) {
    var x = e.screenX
    var y = e.screenY
    var native = typeof x === 'number' && isFinite(x) && typeof y === 'number' && isFinite(y) && (x !== 0 || y !== 0)
    if (native) return { x: x, y: y }
    return { x: window.screenX + e.clientX, y: window.screenY + e.clientY }
  }
  function onDocPointerDown(e) {
    if (e.target && e.target.closest && (e.target.closest('.wp-menu-btn') || e.target.closest('.wp-bubble'))) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!isWhaleHit(e)) return
    try { e.preventDefault() } catch (err) {}
    api.closeMenu() // 点击鲸鱼时主动收起设置窗口
    var abs0 = absPoint(e)
    drag = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      // 最近一次绝对坐标：movement=0 但绝对坐标仍变化（光标已贴物理边界、需要
      // 继续把窗口推出去）时照样上报一次，让主进程绝对锚点四边可达
      lastScreenX: abs0.x,
      lastScreenY: abs0.y,
    }
    try { e.target.setPointerCapture(e.pointerId) } catch (err) {}
    root.classList.add('wp-dragging')
    pressDown()
    setWidgetCursor('grabbing')
    // 附上「可见图形矩形」：主进程据此钳制，四边都能让鲸鱼本体贴到屏幕边
    api.dragStart(e.clientX, e.clientY, abs0.x, abs0.y, fishRect())
    // onDocPointerMove 是持久监听（启动时注册），不在此重复注册，
    // 否则拖动结束 removeEventListener 会把持久监听一并摘掉。
    document.addEventListener('pointerup', onDocPointerUp, true)
    document.addEventListener('pointercancel', onDocPointerCancel, true)
  }

  function onDocPointerMove(e) {
    lastPointerMoveAt = Date.now()
    if (drag && drag.active) {
      // 拖拽中必须持续接收输入（指针捕获），绝不切回穿透
      applyIgnore(false)
      var mx = e.movementX
      var my = e.movementY
      if (typeof mx !== 'number' || !isFinite(mx)) mx = 0
      if (typeof my !== 'number' || !isFinite(my)) my = 0
      // 若 movement 为 0 但绝对坐标仍变化（光标已贴物理边界、需要继续把窗口推出去；
      // 窗口移动合成的回送事件不会改变真实光标位置），照样上报一次
      var absP = absPoint(e)
      var absChanged = absP.x !== drag.lastScreenX || absP.y !== drag.lastScreenY
      if (mx === 0 && my === 0 && !absChanged) return
      drag.lastScreenX = absP.x
      drag.lastScreenY = absP.y
      var dxc = e.clientX - drag.startX
      var dyc = e.clientY - drag.startY
      if (dxc * dxc + dyc * dyc >= CLICK_SQ || Math.abs(mx) + Math.abs(my) > 2) drag.moved = true
      // 逐事件上报：绝对坐标供主进程绝对锚点通道，增量供无绝对坐标时的备通道
      api.dragDelta(mx, my, e.clientX, e.clientY, absP.x, absP.y)
      return
    }
    // 悬停在可点击区域 → 显示菜单按钮 + 抓取光标（按键盒判定，避免滑向按钮时消失）
    var over = inClickable(e)
    menuBtn.classList.toggle('wp-menu-btn-visible', over)
    setWidgetCursor(over ? 'grab' : '')
    // Windows 悬停穿透：在鲸鱼像素/气泡/按钮上 → 接收鼠标；其余 → 直达桌面
    applyIgnore(!overInteractive(e))
  }

  async function onDocPointerUp(e) {
    document.removeEventListener('pointerup', onDocPointerUp, true)
    document.removeEventListener('pointercancel', onDocPointerCancel, true)
    if (!drag || !drag.active) return
    drag.active = false
    var clickAllowed = e.type === 'pointerup'
    pressUp()
    root.classList.remove('wp-dragging')
    setWidgetCursor('')
    if (clickAllowed && !drag.moved) {
      await api.dragEnd()
      showBubble()
      refresh(true)
      applyIgnore(!overInteractive(e))
      return
    }
    await finishDrag()
    applyIgnore(!overInteractive(e))
  }

  async function onDocPointerCancel(e) {
    document.removeEventListener('pointerup', onDocPointerUp, true)
    document.removeEventListener('pointercancel', onDocPointerCancel, true)
    if (!drag || !drag.active) return
    drag.active = false
    pressUp()
    root.classList.remove('wp-dragging')
    setWidgetCursor('')
    await finishDrag()
    applyIgnore(!overInteractive(e))
  }

  async function finishDrag() {
    var end = await api.dragEnd() // {x, y} 主进程记录的最终窗口位置
    var bd = await api.getDisplayBounds()
    var wa = await api.getWorkArea()
    // 自由定位：只按「可见图形四边可贴屏幕边」钳制（与主进程引擎同一套规则）
    var fit = settlePos(Math.round(end.x), Math.round(end.y), bd, wa)
    var x = fit.x
    var y = fit.y
    // 屏幕四角吸附：松手位置离「当前所在那块显示器」的某个角足够近就吸附过去。
    // 吸附目标已按对应朝向算好，先落定朝向后复钳一次即可（落点即钳制边界，
    // 通常零位移），避免朝向切换后可见图形位置反转导致落点偏掉。
    await refreshDisplays()
    var d = displayAt(x, y)
    if (d) {
      var snap = snapCorner(x, y, d)
      if (snap) {
        setFlipped(snap.flip)
        var sf = settlePos(snap.x, snap.y, bd, wa)
        x = sf.x
        y = sf.y
      }
    }
    var rp = await api.setWindowPos(x, y)
    if (rp && isFinite(rp.x) && isFinite(rp.y)) { x = Math.round(rp.x); y = Math.round(rp.y); advancePos(x, y) }
    api.setConfig({ posX: x, posY: y })
    // 注意：此处不得再做 ±1px 的 resizeWindow「表面重建」兜底 —— 它会拆掉并
    // 重建透明窗口的表面，先呈现一帧未绘制的空白缓冲（Windows 上是大黑块），
    // 且每次松手都执行（单屏拖到边角同样触发）。跨屏 DPI 的表面适配已由主进程
    // 的软件合成路径接管（main.js 文件头 disableHardwareAcceleration 注释）。
    reportShape() // 拖拽期间跳过的 shape 在此补报（如拖拽中恰好开合的提示气泡）
  }

  // 鲸鱼/气泡/菜单按钮上的点击才会生效；透明区域（或不在鲸鱼上）的点按
  // 直接忽略（窗口始终接收事件，不做不可靠的 setIgnoreMouseEvents 穿透）。
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('pointermove', onDocPointerMove, true)
  document.addEventListener('contextmenu', function (e) {
    // 无边框窗口默认有 Chromium 右键菜单，先全局禁用
    try { e.preventDefault() } catch (err) {}
    if (isWhaleHit(e)) api.openMenu()
  })

  var widgetCursor = ''
  function setWidgetCursor(v) {
    if (v !== widgetCursor) {
      widgetCursor = v
      try { document.body.style.cursor = v } catch (err) {}
    }
  }

  // ------------------------------------------------------------- 按压/音效
  var SQUISH = 'scaleY(0.88) scaleX(1.05)'
  var pressAudio = null
  var releaseAudio = null
  var pressing = false
  var pressEnded = false
  var releasePlayed = false
  var releaseTimer = null

  function applySoundSet() {
    try {
      var pressSrc = pressSound ? resolveImgPath(pressSound) : (soundSet === 'fx1' ? '../assets/D1.mp3' : '../assets/Ya1.mp3')
      var releaseSrc = releaseSound ? resolveImgPath(releaseSound) : (soundSet === 'fx1' ? '../assets/D2.mp3' : '../assets/Ya2.mp3')
      pressAudio = new Audio(pressSrc)
      pressAudio.preload = 'auto'
      pressAudio.volume = soundVol
      releaseAudio = new Audio(releaseSrc)
      releaseAudio.preload = 'auto'
      releaseAudio.volume = soundVol
    } catch (err) {}
  }

  function playPress() {
    if (!pressAudio || !soundOn) return
    try {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
      if (releaseAudio) {
        releaseAudio.pause()
        releaseAudio.currentTime = 0
      }
      pressEnded = false
      releasePlayed = false
      pressAudio.onended = function () {
        pressEnded = true
        if (!pressing && !releasePlayed) playRelease()
      }
      pressAudio.currentTime = 0
      var p = pressAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }

  function playRelease() {
    if (releasePlayed || !releaseAudio || !soundOn) return
    releasePlayed = true
    try {
      releaseAudio.currentTime = 0
      var p = releaseAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }

  function pressDown() {
    body.style.transform = SQUISH
    pressing = true
    playPress()
  }

  function pressUp() {
    body.style.transform = 'scaleY(1) scaleX(1)'
    pressing = false
    if (pressEnded) {
      playRelease()
      return
    }
    var durKnown = false
    var remainMs = 0
    try {
      var dur = pressAudio ? pressAudio.duration : 0
      if (isFinite(dur) && dur > 0) {
        durKnown = true
        remainMs = (dur - pressAudio.currentTime) * 1000
      }
    } catch (err) {}
    if (durKnown) {
      releaseTimer = setTimeout(function () {
        releaseTimer = null
        playRelease()
      }, Math.max(0, remainMs - 100))
    }
  }

  // ------------------------------------------------------------- 闲置半透明
  function checkIdle() {
    if (!idleFade || (drag && drag.active)) {
      root.classList.remove('wp-idle')
      return
    }
    var idle = Date.now() - lastPointerMoveAt > IDLE_MS
    root.classList.toggle('wp-idle', idle)
  }

  // ------------------------------------------------------------- 配置应用
  async function applyConfig(c, first) {
    if (!c) return
    peakMode = ['liangwen', 'qiangqiang'].includes(c.peakMode) ? c.peakMode : 'default'
    peakText = c.peakText !== false
    bubbleOn = c.bubbleOn !== false
    var bi = (typeof c.bubbleInterval === 'number' && isFinite(c.bubbleInterval)) ? Math.max(0, Math.round(c.bubbleInterval)) : 120
    bi = bi * 1000
    if (bi !== bubbleIntervalMs) {
      bubbleIntervalMs = bi
      if (bubbleIntervalTimer) { clearInterval(bubbleIntervalTimer); bubbleIntervalTimer = null }
      if (bubbleIntervalMs > 0) bubbleIntervalTimer = setInterval(function () { showRandomBubble() }, bubbleIntervalMs)
    }
    idleFade = c.idleFade !== false
    // 闲置不透明度（可调，0.2 - 1.0）
    var idleOp = (typeof c.idleOpacity === 'number' && isFinite(c.idleOpacity)) ? Math.min(1, Math.max(0.2, c.idleOpacity)) : 0.6
    root.style.setProperty('--wp-idle-opacity', String(idleOp))
    soundSet = c.soundSet === 'fx1' ? 'fx1' : 'duck'
    soundVol = typeof c.volume === 'number' ? c.volume : 0.8
    soundOn = soundVol > 0
    threshold = typeof c.lowBalanceThreshold === 'number' ? c.lowBalanceThreshold : 10
    alertImage = c.alertImage === true
    if (typeof c.alertImgPath === 'string' && c.alertImgPath.trim()) alertImgPath = c.alertImgPath.trim()
    if (typeof c.mainImgPath === 'string' && c.mainImgPath.trim()) mainImgPath = c.mainImgPath.trim()
    if (typeof c.bubbleTextOk === 'string' && c.bubbleTextOk.trim()) bubbleTextOk = c.bubbleTextOk.trim().slice(0, 20)
    if (typeof c.bubbleTextLow === 'string' && c.bubbleTextLow.trim()) bubbleTextLow = c.bubbleTextLow.trim().slice(0, 20)
    if (typeof c.textColorOk === 'string') textColorOk = /^#[0-9a-fA-F]{6}$/.test(c.textColorOk.trim()) ? c.textColorOk.trim() : ''
    if (typeof c.textColorLow === 'string') textColorLow = /^#[0-9a-fA-F]{6}$/.test(c.textColorLow.trim()) ? c.textColorLow.trim() : ''
    if (typeof c.peakTextOff === 'string') peakTextOff = c.peakTextOff.trim().slice(0, 12)
    if (typeof c.peakTextOn === 'string') peakTextOn = c.peakTextOn.trim().slice(0, 12)
    if (typeof c.pressSound === 'string') pressSound = c.pressSound.trim()
    if (typeof c.releaseSound === 'string') releaseSound = c.releaseSound.trim()
    var interval = Math.round((typeof c.refreshInterval === 'number' ? c.refreshInterval : 60) * 1000)
    if (interval !== refreshIntervalMs) {
      refreshIntervalMs = interval
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = setInterval(function () { refresh(false) }, refreshIntervalMs)
    }
    applySoundSet()
    if (typeof c.scale === 'number' && c.scale !== state.scale) {
      console.log('[diag] applyConfig scale path: cfg=' + c.scale + ' state=' + state.scale)
      await setScale(c.scale)
    }
    updateHeroImage()
  }

  // ------------------------------------------------------------- 外部事件
  api.onConfigChanged(function (c) { applyConfig(c, false) })
  api.onCustomChanged(function (data) { applyCustom(data) })
  api.onRefresh(function () { refresh(true) })

  // ------------------------------------------------------------- 启动
  async function init() {
    var c = await api.getConfig()
    state.scale = c.scale || 1
    root.style.setProperty('--wp-base', (BASE_PX * state.scale) + 'px')
    // 显示器列表：方向感知锚点与四角吸附的判定基准（单块显示器，非虚拟桌面）
    await refreshDisplays()
    // 默认位置：右下角（等待 initPosition 覆盖为记忆位置）
    var wa0 = await api.getWorkArea()
    state.winW = Math.round(BASE_PX * state.scale)
    state.winH = state.winW
    advancePos(wa0.x + wa0.width - state.winW, wa0.y + wa0.height - state.winH)
    await api.resizeWindow(state.winW, state.winH)
    await initPosition()
    await applyConfig(c, true)
    setupHitTest()
    reportShape() // 非 Windows：按鲸鱼像素轮廓裁剪窗口（透明区域点击穿透）
    applyIgnore(true) // Windows：初始默认穿透，随鼠标悬停交互区自动切换
    api.getCustom().then(applyCustom).catch(function () {})
    refresh(false)
    refreshTimer = setInterval(function () { refresh(false) }, refreshIntervalMs)
    idleCheckTimer = setInterval(checkIdle, 1500)
  }
  init().catch(function (err) { console.error('[whale-pet] init failed', err) })
})()
