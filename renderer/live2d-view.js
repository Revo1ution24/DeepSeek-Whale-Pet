// ---------------------------------------------------------------------------
// Live2D 桌宠运行时（自绘 WebGL，最小实现）
//   Core   : renderer/live2d/live2dcubismcore.min.js（官方 5-r.3，单文件自包含，<script> 先加载）
//   模型   : renderer/live2d/zz_hand2_sync/（moc3 + 4096 贴图，PSD2Live 0.7.1 生成）
//   字节流 : 渲染进程 sandbox 下 fetch(file:) 不可用 → 走 whaleAPI.readL2D（主进程读文件）
//
// 行为参数（需求定稿：不要身体/脸的左右摇晃）：
//   ParamEyeBallX/Y  ← 光标方向（眼部鼠标跟踪）
//   ParamEyeLOpen/ROpen + EyeBallY 下压 ← 眨眼（睫毛下沉 + 虹膜躲进睫毛下）
//   ParamHairFront/Back ← 怠速正弦摆动（前后发摇摆，相位错开）
//   ParamAngleZ 小幅   ← 呆毛摆动（呆毛只挂在头部变形链上，唯一驱动途径）
//   ParamBodyAngle* 与大幅 AngleX/Y 一律不驱动 → 身体/脸不摇
//
// 闭眼叠加（closed_eyes.png，由 zz_closed_gen.js 生成）：绑定本身只能把睫毛下压
// 14px（半闭），闭不严；眨眼瞬间额外叠一张「眼盘填肤色 + 睫毛带 + 浅弧」的素材，
// 复刻 PNG 闭眼帧的观感。素材是全画布 512² 的静态图，按 face 层两个基准顶点
// 的相似变换（平移+旋转+尺度）逐帧锚定 → 跟着 ±2° 摆头一起动，不脱位。
// 素材缺失时自动退回「仅绑定变形」眨眼，不致命。
//
// 对外 API（window.WhaleLive2D）：
//   init(api, container, beforeEl) -> Promise<bool>   读资产 + 建 WebGL（挂 canvas 到 container）
//   ready() -> bool   初始化是否成功
//   setActive(on)     模式开/关（关时停 RAF 并隐藏 canvas）
//   setGaze(nx, ny)   目标视线（本地坐标系 -1..1，调用方已做镜像修正）
//   setBlink(on)      眨眼瞬间开关
// ---------------------------------------------------------------------------
(function () {
  'use strict'

  var MOC_REL = 'zz_hand2_sync/zz_hand2_sync.moc3'
  var TEX_REL = 'zz_hand2_sync/texture_00.png'
  var CLOSED_REL = 'zz_hand2_sync/closed_eyes.png'

  var Z_NEUTRAL = 4.9198604   // 建模初始头倾角（美术中性姿态，围绕它摆动）
  var Z_SWAY = 2.0            // 呆毛摆动幅度（±度）
  var BLINK_EYE_DOWN = -1     // 眨眼时视线下压量（已核验：-1 = 虹膜向下）

  var canvas = null
  var gl = null, prog = null, attribs = {}, uniforms = {}
  var tex = null
  var model = null
  var layers = []             // 绘制序的 [{ i, order, posBuf, bytes, indexCount, idxBuf }]
  var overlay = null          // 闭眼叠加 { tex, posBuf, uvBuf, idxBuf, n0x,n0y, refA, refB }
  var paramIdx = {}
  var readyFlag = false, failed = false, running = false
  var gazeTX = 0, gazeTY = 0, gazeX = 0, gazeY = 0
  var blinkOn = false
  var rafId = null, lastT = 0

  function log(msg) { console.log('[l2d] ' + msg) }

  var VS = [
    'attribute vec2 aPos;',
    'attribute vec2 aUV;',
    'uniform vec2 uScale;',
    'uniform vec2 uOffset;',
    'varying vec2 vUV;',
    'void main() {',
    '  gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0);',
    '  vUV = aUV;',
    '}',
  ].join('\n')
  var FS = [
    'precision mediump float;',
    'varying vec2 vUV;',
    'uniform sampler2D uTex;',
    'uniform float uOpacity;',
    'void main() {',
    '  vec4 c = texture2D(uTex, vUV);',
    '  gl_FragColor = vec4(c.rgb, c.a * uOpacity);',
    '}',
  ].join('\n')

  function compile(type, src) {
    var s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s))
    }
    return s
  }

  async function init(api, container, beforeEl) {
    if (readyFlag || failed) return readyFlag
    try {
      if (typeof Live2DCubismCore === 'undefined') throw new Error('Live2DCubismCore 未加载（检查 <script> 顺序）')
      var C = Live2DCubismCore

      // ---- 读取 moc3 / 贴图（走主进程 IPC）----
      var mocR = await api.readL2D(MOC_REL)
      if (!mocR || !mocR.ok) throw new Error('moc3 读取失败: ' + (mocR && mocR.error))
      var texR = await api.readL2D(TEX_REL)
      if (!texR || !texR.ok) throw new Error('贴图读取失败: ' + (texR && texR.error))

      var mb = mocR.data
      var ab = (mb.byteOffset === 0 && mb.byteLength === mb.buffer.byteLength)
        ? mb.buffer : mb.buffer.slice(mb.byteOffset, mb.byteOffset + mb.byteLength)
      var moc = C.Moc.fromArrayBuffer(ab)
      if (!moc) throw new Error('moc3 解析失败（Core 版本不匹配？）')
      model = C.Model.fromMoc(moc)
      if (!model) throw new Error('模型实例创建失败')

      // ---- canvas + WebGL ----
      canvas = document.createElement('canvas')
      canvas.className = 'wp-img wp-img-l2d'
      canvas.setAttribute('aria-hidden', 'true')
      var ci = model.canvasinfo
      canvas.width = ci.CanvasWidth
      canvas.height = ci.CanvasHeight
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
      if (!gl) throw new Error('WebGL 不可用')
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault()
        failed = true
        readyFlag = false
        stopLoop()
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
        log('WebGL 上下文丢失 → 回退 PNG 模式')
      })

      prog = gl.createProgram()
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('program 链接失败: ' + gl.getProgramInfoLog(prog))
      }
      attribs.aPos = gl.getAttribLocation(prog, 'aPos')
      attribs.aUV = gl.getAttribLocation(prog, 'aUV')
      uniforms.uScale = gl.getUniformLocation(prog, 'uScale')
      uniforms.uOffset = gl.getUniformLocation(prog, 'uOffset')
      uniforms.uTex = gl.getUniformLocation(prog, 'uTex')
      uniforms.uOpacity = gl.getUniformLocation(prog, 'uOpacity')

      // 模型单位 → 裁剪空间：x = (OX + u*PPU)/W*2-1，y = 1 - 2*(OY - u*PPU)/H
      var W = ci.CanvasWidth, H = ci.CanvasHeight, PPU = ci.PixelsPerUnit
      gl.useProgram(prog)
      gl.uniform2f(uniforms.uScale, 2 * PPU / W, 2 * PPU / H)
      gl.uniform2f(uniforms.uOffset, 2 * ci.CanvasOriginX / W - 1, 1 - 2 * ci.CanvasOriginY / H)
      gl.uniform1i(uniforms.uTex, 0)

      // ---- 贴图（IPC 字节 → Blob → ImageBitmap；v 在 UV 数据侧翻转）----
      var bmp = await createImageBitmap(new Blob([texR.data], { type: 'image/png' }))
      var bmpW = bmp.width, bmpH = bmp.height
      tex = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      if (bmp.close) bmp.close()

      // ---- 参数索引 ----
      var ids = Array.from(model.parameters.ids)
      for (var k = 0; k < ids.length; k++) paramIdx[ids[k]] = k
      // 全部参数先归默认（我们只驱动少数几个）
      var P = model.parameters
      for (var p = 0; p < P.count; p++) P.values[p] = P.defaultValues[p]

      // ---- 层缓冲（静态 UV[翻转 v] / 索引；顶点位置每帧上传）----
      var D = model.drawables
      var order = []
      for (var i = 0; i < D.count; i++) order.push(i)
      order.sort(function (a, b) { return D.renderOrders[a] - D.renderOrders[b] }) // 升序 = 由底到顶
      layers = order.map(function (di) {
        var uvSrc = D.vertexUvs[di]
        var uv = new Float32Array(uvSrc.length)
        for (var j = 0; j < uvSrc.length; j += 2) { uv[j] = uvSrc[j]; uv[j + 1] = 1 - uvSrc[j + 1] }
        var uvBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
        gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
        var idxBuf = gl.createBuffer()
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, D.indices[di], gl.STATIC_DRAW)
        // posBuf 必须先分配存储再逐帧 bufferSubData —— 往从未 bufferData 过的
        // 空 buffer 写数据会被 GL 静默拒绝（INVALID_VALUE/OPERATION），顶点全读 0，
        // 整帧退化为空画（教训：本 bug 曾让画布 100% 透明且全程无 JS 异常）。
        var posLen = D.vertexPositions[di].length
        var posBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(posLen), gl.DYNAMIC_DRAW)
        return {
          i: di,
          posBuf: posBuf,
          bytes: posLen * 4,
          uvBuf: uvBuf,
          idxBuf: idxBuf,
          indexCount: D.indexCounts[di],
        }
      })

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.DEPTH_TEST)

      // ---- 闭眼叠加素材（可选：缺失/标定不符时自动退回「仅绑定变形」眨眼）----
      model.update() // 先把默认参数落到顶点上——「中性姿态」基准必须基于它
      try {
        var cr = await api.readL2D(CLOSED_REL)
        if (!cr || !cr.ok) throw new Error('素材缺失: ' + (cr && cr.error))
        var Dn = model.drawables
        var FACE_DI = 7 // 标定（zz_layer_map.js）：vtx=325、renderOrder=2、bbox(152,182)-(435,512)
        if (Dn.vertexCounts[FACE_DI] !== 325) throw new Error('face 层标定不符 vtx=' + Dn.vertexCounts[FACE_DI])
        var OX = ci.CanvasOriginX, OY = ci.CanvasOriginY
        var fv = Dn.vertexPositions[FACE_DI]
        var nV = fv.length / 2
        var fcx = 0, fcy = 0
        for (var q = 0; q < nV; q++) { fcx += fv[q * 2]; fcy += fv[q * 2 + 1] }
        fcx = OX + (fcx / nV) * PPU; fcy = OY - (fcy / nV) * PPU
        if (Math.abs(fcx - 293) > 35 || Math.abs(fcy - 347) > 35) {
          throw new Error('face 层质心偏移(' + fcx.toFixed(0) + ',' + fcy.toFixed(0) + ')')
        }
        // 基准顶点：脸层最左/最右两顶点（相距 ~0.55 单位，旋转估计稳）
        var refA = 0, refB = 0
        for (var q2 = 1; q2 < nV; q2++) {
          if (fv[q2 * 2] < fv[refA * 2]) refA = q2
          if (fv[q2 * 2] > fv[refB * 2]) refB = q2
        }
        var bmp2 = await createImageBitmap(new Blob([cr.data], { type: 'image/png' }))
        var bmp2W = bmp2.width, bmp2H = bmp2.height
        var oTex = gl.createTexture()
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, oTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp2)
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        if (bmp2.close) bmp2.close()
        // 全画布四边形（画布像素角点 → 模型单位；v 翻转与主贴图一致）
        var posBuf2 = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf2)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(8), gl.DYNAMIC_DRAW)
        var uvBuf2 = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf2)
        // 自定义四边形的 UV 直映射（角点(0,0)=屏幕左上 ↔ 贴图(0,0)=图像顶行）。
        // 注意：这里不能照抄主贴图的 v 翻转——那次翻转是对齐 Core UV 约定的，
        // 与本四边形的像素坐标系无关；照抄会把闭眼素材整幅上下镜像。
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW)
        var idxBuf2 = gl.createBuffer()
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf2)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW)
        overlay = {
          tex: oTex, posBuf: posBuf2, uvBuf: uvBuf2, idxBuf: idxBuf2,
          corners: [[0, 0], [W, 0], [W, H], [0, H]].map(function (p) {
            return [(p[0] - OX) / PPU, (OY - p[1]) / PPU]
          }),
          n0x: fv[refA * 2], n0y: fv[refA * 2 + 1],
          n1x: fv[refB * 2], n1y: fv[refB * 2 + 1],
          refA: refA, refB: refB, di: FACE_DI,
          scratch: new Float32Array(8),
        }
        gl.bindTexture(gl.TEXTURE_2D, tex)
        log('闭眼叠加素材就绪（' + bmp2W + 'x' + bmp2H + '）')
      } catch (err2) {
        overlay = null
        log('闭眼叠加不可用（' + ((err2 && err2.message) || err2) + '）→ 眨眼仅绑定变形')
      }

      if (beforeEl && beforeEl.parentNode === container) container.insertBefore(canvas, beforeEl)
      else container.appendChild(canvas)

      readyFlag = true
      lastT = 0
      log('初始化完成：' + D.count + ' 层 / 贴图 ' + bmpW + 'x' + bmpH + 'px / 画布 ' + W + 'x' + H)
      startLoop()
      return true
    } catch (err) {
      failed = true
      log('初始化失败（回退 PNG 模式）：' + ((err && err.message) || err))
      return false
    }
  }

  // ---- 参数驱动 --------------------------------------------------------------
  function setParam(name, v) {
    var i = paramIdx[name]
    if (i !== undefined) model.parameters.values[i] = v
  }

  function clamp1(v) { return v < -1 ? -1 : v > 1 ? 1 : v }

  function step(dt, t) {
    // 视线平滑（20Hz 目标 → 60fps 插值）
    var k = Math.min(1, dt * 12)
    gazeX += (gazeTX - gazeX) * k
    gazeY += (gazeTY - gazeY) * k
    // 前后发怠速摆动：两组正弦叠加（相位错开），注视方向轻微带动
    var hf = Math.sin(t * 1.25) * 0.5 + Math.sin(t * 0.53 + 1.7) * 0.22
    var hb = Math.sin(t * 1.05 + 0.8) * 0.45 + Math.sin(t * 0.41 + 3.2) * 0.18
    hf = clamp1(hf - gazeX * 0.12)
    hb = clamp1(hb - gazeX * 0.08)
    // 呆毛：AngleZ 以中立姿态为中心的缓慢摆动
    var az = Z_NEUTRAL + Math.sin(t * 0.9) * Z_SWAY

    setParam('ParamEyeBallX', gazeX)
    setParam('ParamEyeBallY', blinkOn ? BLINK_EYE_DOWN : gazeY)
    setParam('ParamEyeLOpen', blinkOn ? 0 : 1)
    setParam('ParamEyeROpen', blinkOn ? 0 : 1)
    setParam('ParamHairFront', hf)
    setParam('ParamHairBack', hb)
    setParam('ParamAngleZ', az)
    model.update()
  }

  function draw() {
    var D = model.drawables
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    for (var n = 0; n < layers.length; n++) {
      var L = layers[n]
      if ((D.dynamicFlags[L.i] & 1) === 0) continue
      var pos = D.vertexPositions[L.i] // 每帧新鲜访问（防句柄时效问题）
      gl.bindBuffer(gl.ARRAY_BUFFER, L.posBuf)
      if (pos.byteLength !== L.bytes) { L.bytes = pos.byteLength; gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW) }
      else gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos)
      gl.enableVertexAttribArray(attribs.aPos)
      gl.vertexAttribPointer(attribs.aPos, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, L.uvBuf)
      gl.enableVertexAttribArray(attribs.aUV)
      gl.vertexAttribPointer(attribs.aUV, 2, gl.FLOAT, false, 0, 0)
      gl.uniform1f(uniforms.uOpacity, D.opacities[L.i])
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.idxBuf)
      gl.drawElements(gl.TRIANGLES, L.indexCount, gl.UNSIGNED_SHORT, 0)
    }

    // 闭眼叠加：眨眼瞬间把「闭眼素材」整幅盖上去（蒙皮盖住眼球/睫毛，
    // 素材自带的肤色盘+睫毛带读作闭眼）。位置=脸层基准顶点的相似变换，
    // 平移+旋转+尺度都跟着头一起动（±2° 摆头下与眼区零脱位）。
    if (blinkOn && overlay) {
      var fv2 = D.vertexPositions[overlay.di]
      var v0x = fv2[overlay.refA * 2], v0y = fv2[overlay.refA * 2 + 1]
      var v1x = fv2[overlay.refB * 2], v1y = fv2[overlay.refB * 2 + 1]
      var dnx = overlay.n1x - overlay.n0x, dny = overlay.n1y - overlay.n0y
      var dvx = v1x - v0x, dvy = v1y - v0y
      var ln = Math.sqrt(dnx * dnx + dny * dny), lv = Math.sqrt(dvx * dvx + dvy * dvy)
      var ca = (dnx * dvx + dny * dvy) / (ln * lv)
      var sa = (dnx * dvy - dny * dvx) / (ln * lv)
      var kk = lv / ln
      var tx = v0x - kk * (ca * overlay.n0x - sa * overlay.n0y)
      var ty = v0y - kk * (sa * overlay.n0x + ca * overlay.n0y)
      var out = overlay.scratch
      for (var c2 = 0; c2 < 4; c2++) {
        var cx2 = overlay.corners[c2][0], cy2 = overlay.corners[c2][1]
        out[c2 * 2] = kk * (ca * cx2 - sa * cy2) + tx
        out[c2 * 2 + 1] = kk * (sa * cx2 + ca * cy2) + ty
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, overlay.posBuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, out)
      gl.enableVertexAttribArray(attribs.aPos)
      gl.vertexAttribPointer(attribs.aPos, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, overlay.uvBuf)
      gl.enableVertexAttribArray(attribs.aUV)
      gl.vertexAttribPointer(attribs.aUV, 2, gl.FLOAT, false, 0, 0)
      gl.uniform1f(uniforms.uOpacity, 1)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, overlay.tex)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, overlay.idxBuf)
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
    }
  }

  function frame(ts) {
    rafId = requestAnimationFrame(frame)
    if (!readyFlag || !running || !model) return
    var t = ts / 1000
    var dt = lastT ? Math.min(0.05, t - lastT) : 0.016
    lastT = t
    try {
      step(dt, t)
      draw()
    } catch (err) {
      failed = true
      readyFlag = false
      stopLoop()
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
      log('渲染异常 → 回退 PNG 模式：' + ((err && err.message) || err))
    }
  }

  function startLoop() {
    if (rafId === null) rafId = requestAnimationFrame(frame)
  }
  function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
    lastT = 0
  }

  window.WhaleLive2D = {
    init: init,
    ready: function () { return readyFlag },
    setActive: function (on) {
      running = !!on
      if (running) { lastT = 0; startLoop() }
      else stopLoop()
    },
    setGaze: function (nx, ny) {
      gazeTX = clamp1(Number(nx) || 0)
      gazeTY = clamp1(Number(ny) || 0)
    },
    setBlink: function (on) { blinkOn = !!on },
  }
})()
