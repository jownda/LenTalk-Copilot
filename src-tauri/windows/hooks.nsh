; ─────────────────────────────────────────────────────────────────────────────
; LenTalk NSIS 安装挂钩（tauri.conf.json → bundle.windows.nsis.installerHooks）
;
; 目的：Windows 7 / 8 / 8.1 上**无法运行**本程序，必须提前拦下并给一句能看懂的中文提示，
; 而不是装完之后让用户启动时报
;   「无法定位程序输入点 ProcessPrng 于动态链接库 bcryptprimitives.dll 上」。
;
; 为什么 Win7 跑不了（两条硬性限制，都不是应用代码能绕开的）：
;   1. Rust 1.78 起，标准库在 Windows 上用 bcryptprimitives.dll!ProcessPrng 取随机数，
;      而 Win7 的 bcryptprimitives.dll 没有这个导出 → 进程在“加载阶段”就失败（main 都进不去）。
;      最后一个仍兼容 Win7 的 Rust 是 1.77.2。
;   2. Tauri v2 依赖 Edge WebView2 运行时；微软自 WebView2 110 / SDK 1.0.1519.0 起不再支持
;      Win7 与 8/8.1（109 为最后一个支持版本，且已停止更新）。即便降级 Rust 编译通过，
;      也没有可用的 WebView2。
;
; 判断依据：注册表 CurrentBuildNumber
;   Win10 = 10240 起；Win8.1 = 9600、Win8 = 9200、Win7(SP1) = 7601 → 全部 < 10240，拦下。
;   阈值取 10240 与微软「WebView2 支持 Windows 10 SAC 1709 及更高 / 含 1507·2016 LTSC」口径一致。
;
; 说明：本宏由 Tauri 模板插入到 `Section Install` 开头（在拷贝文件之前），
; 位于其自带的 WebView2 段之后；若某些机器上 WebView2 下载直接失败，
; Tauri 会先用自己的文案中止安装（同样不会被装上一个跑不起来的版本）。
; ─────────────────────────────────────────────────────────────────────────────

!macro NSIS_HOOK_PREINSTALL
  ; 保护 Tauri 模板正在使用的寄存器
  Push $R9
  ReadRegStr $R9 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"

  ; $R9 == 10240 → 放行；< 10240（Win7/8/8.1）→ 拦截；> 10240 → 放行
  IntCmp $R9 10240 lentalk_winver_ok lentalk_winver_block lentalk_winver_ok

lentalk_winver_block:
  MessageBox MB_OK|MB_ICONSTOP "LenTalk 需要 Windows 10（1809）或更高版本。$\r$\n$\r$\nWindows 7 / 8 / 8.1 已不再被 Microsoft Edge WebView2 支持，本程序无法在这些系统上运行。$\r$\n请升级到 Windows 10 / 11 后重新安装。$\r$\n$\r$\nLenTalk requires Windows 10 (1809) or later."
  ; 此时仅 SetOutPath 建过目录，未写入任何文件/注册表，清掉空目录后退出
  RMDir "$INSTDIR"
  Quit

lentalk_winver_ok:
  Pop $R9
!macroend
