# DeepSeek Whale Pet · 余额小鲸鱼桌宠

![DeepSeek 余额小鲸鱼](assets/DSH2.png)

一只常驻桌面右下角的透明置顶小鲸鱼，实时提醒你的 **DeepSeek 余额与今日消耗**。拖得走、按得叫、会说随机台词；完全独立运行，不依赖 DSH / 浏览器。

> 本仓库是基于 [momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet) 修改的 **1.0.1** 版本。

## 下载安装（普通用户）

到 [Releases](https://github.com/Revo1ution24/DeepSeek-Whale-Pet/releases) 下载对应平台的安装包，**无需安装 Node.js**：

| 平台 | 文件 |
|---|---|
| Windows x64 | `DeepSeek.Whale.Pet-1.0.1-x64.exe` |
| Windows arm64 | `DeepSeek.Whale.Pet-1.0.1-arm64.exe` |
| Linux x86_64 / arm64 / armv7l | `*.AppImage`（免安装）/ `.deb` / `.rpm` / `.tar.gz` |
| macOS x64 / arm64 | `*.dmg` / `*.zip` |

- **Windows**：双击 `.exe` 安装，可自选安装路径，自动创建桌面与开始菜单快捷方式。
- **Linux**：`chmod +x DeepSeek.Whale.Pet-*.AppImage && ./DeepSeek.Whale.Pet-*.AppImage`，或 `sudo apt install ./DeepSeek.Whale.Pet-*.deb`。
- **macOS**：打开 `.dmg` 把应用拖入「应用程序」。

安装包未做代码签名，Windows SmartScreen / macOS Gatekeeper 可能提示「未知发布者」，分别选择「仍要运行」或右键「打开」即可。

## 功能

- 💰 余额监控：60s 自动刷新，点击鲸鱼手动刷新；余额变化有滚动动画
- 📊 今日已用：免令牌记账模式（默认，余额差值记账，跨天归档 30 天）或平台用量接口 + 峰谷定价实时换算
- 🖱️ 自由拖拽：无贴边吸附，可拖到屏幕任意边缘（含顶部）
- 💬 气泡交互：单击显示余额；点击气泡切换随机台词（可自定义池与权重）
- ⚙️ 系统集成：托盘、设置窗口（6 个 Tab）、全局热键 `Ctrl+Shift+R`、开机自启、单实例
- 🎵 按压音效、闲置半透明、预警换图、自定义主图/文案/颜色

## 快速开始（源码运行）

```bash
npm install
npm start
```

启动后鲸鱼出现在屏幕右下角；右键鲸鱼 → 设置 → 填入 **API Key**（`sk-` 开头）即可显示余额（与安装版用法相同）。

## 使用

| 操作 | 效果 |
|---|---|
| 单击鲸鱼 | 弹气泡显示余额 + 今日已用 |
| 按住拖动 | 移动鲸鱼，松手停在当前位置 |
| 右键 / 汉堡按钮 | 打开设置 |
| `Ctrl+Shift+R` | 全局刷新 |

## 配置

- 配置文件：`~/.config/whale-pet/`（Windows `%APPDATA%/whale-pet`，macOS `~/Library/Application Support/whale-pet`）
- API Key 也可用环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_PLATFORM_TOKEN` 提供
- 随机台词池：`lines.json`（首次自动生成，可自由编辑）

## 开发

```bash
npm test          # 单元测试
npm run smoke     # 冒烟测试（真实启动）
npm run dist:win  # 打包 Windows 安装包（可选安装路径）
npm run dist:linux # 打包 Linux（AppImage/deb/rpm）
```

## 参考

- 本仓库来源：[momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet)（本项目在其基础上修改，感谢原作者 momo-OwO-qwq）
- 上游设计：[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
- 详细架构与行为规格见 [docs/design.md](docs/design.md) 与 [docs/repro-prompt.md](docs/repro-prompt.md)

## 许可证

MIT