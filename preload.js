'use strict'
// ---------------------------------------------------------------------------
// 预加载脚本：contextBridge 暴露安全的 IPC 桥（window.whaleAPI）
// 渲染进程（鲸鱼窗口 + 设置窗口）无法直接访问 Node，只能走这里的方法。
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleAPI', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  // 余额（主进程内缓存 + 去重）
  getBalance: () => ipcRenderer.invoke('balance:get'),
  // 窗口
  getWorkArea: () => ipcRenderer.invoke('window:get-workarea'),
  getDisplayBounds: () => ipcRenderer.invoke('window:get-display-bounds'),
  // 每块显示器的 bounds/workArea（朝向判定 + 四角吸附按单块显示器计算）
  getDisplays: () => ipcRenderer.invoke('window:get-displays'),
  // 改为 invoke：主进程执行后返回真实窗口 bounds（{x,y,width,height}），
  // 渲染进程据此同步 state.winW/winH/posX/posY 再重报 shape —— 缩放后
  // 碰撞箱（点击区/拖拽锚点）与视觉尺寸保持一致（修复「缩小时右/下空气墙」）。
  resizeWindow: (w, h) => ipcRenderer.invoke('window:resize', { w, h }),
  setWindowPos: (x, y) => ipcRenderer.invoke('window:set-pos', { x, y }),
  // 透明点击穿透：把窗口裁剪为 鲸鱼/气泡/按钮 区域，其余部分点击直接落到桌面
  setShape: (rects) => ipcRenderer.send('pet:shape', { rects }),
  // Windows 悬停穿透（替代 setShape 区域）：setIgnoreMouseEvents(forward) 转发
  // move 给渲染进程做像素级判定 —— 区域+透明层跨屏移动会黑框闪烁/图像残损
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', { ignore: !!ignore, forward: true }),
  platform: process.platform,
  // 拖拽：渲染进程上报原始位移增量 + 实时绝对屏幕坐标（screenX/Y，OS 实时下发，
  // 不依赖主进程 getCursorScreenPoint 缓存）。主进程以绝对坐标为主通道移动窗口；
  // dragEnd 返回最终窗口位置（供吸附/保存）
  // Muzyu新增：fish：可见鲸鱼在窗口内的矩形（CSS px，含镜像），主进程据此钳制四边贴边
  dragStart: (offsetX, offsetY, screenX, screenY, fish) => ipcRenderer.invoke('drag:start', { offsetX, offsetY, screenX, screenY, fish }),
  dragDelta: (dx, dy, cx, cy, screenX, screenY) => ipcRenderer.send('drag:delta', { dx, dy, cx, cy, screenX, screenY }),
  dragEnd: () => ipcRenderer.invoke('drag:end'),
  // 主图 / 预警图上传（复制到配置目录） + 恢复默认
  pickImage: (kind) => ipcRenderer.invoke('image:pick', { kind }),
  resetImage: (kind) => ipcRenderer.invoke('image:reset', { kind }),
  // 自定义音效（按压/松手）上传 + 恢复默认
  pickSound: (which) => ipcRenderer.invoke('sound:pick', { which }),
  // Live2D 模型资产（只读 renderer/live2d 目录；sandbox 下渲染进程无法直接读文件）
  readL2D: (rel) => ipcRenderer.invoke('l2d:read', { rel }),
  resetSound: (which) => ipcRenderer.invoke('sound:reset', { which }),
  // 自定义随机台词/动图（~/.config/whale-pet/lines.json，含默认池）
  getCustom: () => ipcRenderer.invoke('custom:get'),
  reloadCustom: () => ipcRenderer.invoke('custom:reload'),
  // 设置窗口
  openMenu: () => ipcRenderer.send('menu:open'),
  closeMenu: () => ipcRenderer.send('menu:close'),
  // 用系统默认程序打开文件/目录/URL
  openPath: (path) => ipcRenderer.invoke('shell:open-path', { path }),
  // 全局光标（主进程 20Hz 轮询推送，{x,y} 为 DIP）：眼睛追踪 + 忙碌判定共用
  onCursorTick: (cb) => ipcRenderer.on('cursor:tick', (_e, pt) => cb(pt)),
  // 事件
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  onCustomChanged: (cb) => ipcRenderer.on('custom:changed', (_e, data) => cb(data)),
  onRefresh: (cb) => ipcRenderer.on('whale:refresh', () => cb()),
  // 主进程通知（如 Harness 启动结果）→ 以气泡文案展示
  onNotice: (cb) => ipcRenderer.on('whale:notice', (_e, text) => cb(text)),
})
