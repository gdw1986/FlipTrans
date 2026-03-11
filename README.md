# FlipTrans

一款基于 **Tauri + React (Vite)** 的桌面翻译工具，主打“轻量、快捷、可配置”。支持剪贴板自动监听、一键翻译与历史记录管理。

## ✨ 功能特性
- **剪贴板自动监听**：复制即翻译（可开关）
- **多引擎可配置**：OpenAI 兼容 /chat/completions
- **翻译历史**：本地保存与快速回看
- **方向可选**：如 zh→en / en→zh
- **朗读**：系统语音朗读，支持选择 Edge/微软中文语音

## 🧩 技术栈
- 前端：React + Vite
- 桌面：Tauri
- 后端：Rust（调用 OpenAI 兼容接口）

## 🚀 开发启动
```bash
# 安装依赖
npm install

# 启动前端 + Tauri
npm run tauri dev
```

## 🛠️ 生产构建
```bash
npm run tauri build
```

## ⚙️ 配置说明
配置与历史保存在系统 `app_config_dir/fliptrans` 目录下。

### TTS 说明
- 朗读基于系统 Web Speech API（speechSynthesis）。
- Windows + Edge 通常提供 “Microsoft Neural / Natural” 语音（带声调）。
- 在“设置”中可分别选择中文/英文朗读语音，默认自动挑选。

## 📄 许可
MIT
