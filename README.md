# 🍑 桃桃便签 · Momo Notes

带桌宠的日历便签。桌面版的桃桃平时在桌面，单击后趴到便签右上角，再点她就收起便签。移动版在应用内保留桌宠和便签页面。

![桃桃便签显示一条已完成事项和一条待办](docs/preview.png)

## 安装

在 [GitHub Releases](https://github.com/SDUM-Liu/momo-notes/releases) 下载对应平台的包。Windows 安装程序未签名。Ubuntu 版为 x64 AppImage，贴边和窗口定位使用 X11 或 XWayland。

跨平台构建可在 [GitHub Actions](https://github.com/SDUM-Liu/momo-notes/actions) 下载。macOS 预览包未签名或公证，iOS 构建用于模拟器，Android APK 是调试签名的测试包。iOS 真机分发和 macOS 公证需要 Apple 签名凭据，Android 正式分发需要固定的签名密钥。

## 在线更新

Windows 安装版和 Ubuntu AppImage 启动后会检查 GitHub Releases，有新版时设置图标会显示提示点。也可以在「设置 → 应用更新」手动检查、下载，再点击「安装并重启」。可启用「后台下载，退出时自动安装」，编辑时不会被强制重启。升级沿用原有的便签和设置。正式签名的 macOS 版可沿用应用内更新，未签名预览版通过重新下载安装包更新。Android 和 iOS 通过对应发行渠道更新。

正在使用 v0.1.0 时，需手动下载并运行新版安装包一次。

## 使用

- 启动后显示桌宠。点桌宠或任务栏托盘中的桃桃图标打开便签。便签面板约占当前显示器工作区的八分之一，小屏幕会优先保留编辑空间。
- 拖动桌宠或便签标题到屏幕边缘可收起为边栏入口。单击边栏打开便签，或把它拖离边缘恢复桌宠。可在设置中关闭贴边收起和窗口置顶、启用开机启动、替换边栏图片。
- 每天按 Windows 本地日期创建新页。日历按钮可查看今天和有记录的旧页。应用连续运行时会自动切换到新的一天，也可随时从历史页返回今天。
- 新页默认是编号待办。输入事项后按 Enter 新增下一条，空白待办按 Enter 退出列表。可勾选白色方块标记完成，再次点击恢复。
- 工具栏支持粗体、斜体、下划线、删除线、标题、列表、图片和表格。图片也可粘贴或拖入。选中表格内某个单元格后可添加或删除行列。
- 用编辑工具栏的链接按钮插入链接，或从顶部的浏览器按钮输入网址。点击便签中的链接会在应用内打开。浏览器内可后退到上一张网页，也可随时「返回便签」回到同一页。
- 飞书等在线平台需要在浏览器内登录。使用同一飞书账号打开同一文档时，由飞书同步文档。桃桃的每日便签仍保存在当前设备。
- 各平台共用便签编辑器。桌面窗口置顶、开机启动、贴边隐藏和边栏换图适用于桌面版。各平台可为 AI 请求指定本机 HTTP 代理端口。

## AI 问答

1. 打开设置，填写兼容 Chat Completions 的 API 地址和模型 ID。例如接口地址为 `https://example.com/v1/chat/completions` 时，API 地址可以填 `https://example.com/v1`。
2. 云服务通常需要 API 密钥。本机 API 可以使用 HTTP，其他地址须使用 HTTPS。使用本地 HTTP 代理时填入它的端口，留空则直连。
3. 点工具栏的星星，选择当前日期或含历史便签，再输入问题并发送。请求包含问题和选定便签的文字及完成状态。图片按占位符提供，历史文字最多发送约 24,000 字符。

桌面便签按日保存在应用数据目录的 `notes/` 中。右键托盘图标可打开目录。移动版使用应用内的本地数据库。AI 密钥由系统凭据存储保护，AI 请求只在主动发送问题时发出。

## 从源码运行

使用 Node.js 22.12+（建议 Node.js 24）。

```powershell
npm ci
npm start
```

- Windows 使用 `npm run dist`，Ubuntu 使用 `npm run dist:linux`，macOS 使用 `npm run dist:mac:preview` 或在有正式签名时使用 `npm run dist:mac`。输出在 `release/`。
- Android 使用 `npm run mobile:sync -- android` 后在 Android Studio 打开 `android/`，或在该目录运行 `./gradlew assembleDebug`。需 JDK 21、Android SDK 36。应用要求 Android 9 及以上。
- iOS 使用 `npm run mobile:sync -- ios` 后在 Xcode 打开 `ios/App/App.xcodeproj`。应用要求 iOS 15.4 及以上。
- 发布正式版时，从同一次构建上传平台的安装包和更新元数据。Windows 需要 `.exe.blockmap` 和 `latest.yml`，Ubuntu 需要 `latest-linux.yml`，正式签名的 macOS 版需要 `latest-mac.yml` 及构建出的块映射。
- `main` 是开发主线。每次正式发布保留 `v版本号` 标签、GitHub Release 和 `release/版本号` 分支。

源码采用 MIT 许可证。

## 角色素材

用内置 ImageGen 为原创角色生成三个透明贴图，保存在 `src/assets/`。三种构图为全身挥手、双手扒住便签上缘、双手抱住侧边栏把手。共同设定为短深梅色头发、桃子发夹、杏色开衫和柔和的桃粉配色。
