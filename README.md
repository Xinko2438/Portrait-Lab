# Portrait Lab 双图布局预览

2026-11-27。改前 Git 提交为 `68d42ef`。样式基线来自东京发布 `460ca3dea2b7773a63ea338982d620ba71477834b1e53df7fc94ad64220650f7` 的 `site/folio/portrait-lab/app.css`。本地候选目录的 `app.css` 记录本次样式，`site` 是同版本的可运行对照副本。此候选用于评审视觉取舍，正式发布使用项目现有构建与验证流程。

从本目录运行 `python -B -m http.server 4191 --bind 127.0.0.1 --directory site`。打开 http://127.0.0.1:4191/folio/portrait-lab/?run=run-demo-selected&from=history 。重建时复制该东京版的 Portrait Lab 目录到 `site/folio/portrait-lab`，把本目录的 `app.css` 覆盖到副本。

设置 `PLAYWRIGHT_MODULE_PATH`，运行 `node verify-layout.cjs --capture`。覆盖 1706×932（1.5 倍像素密度）、1366×768、390×844 的选择与评分。候选验收检查图片框、原图比例、可用高度、同高、不重叠、评分切换、参考图和批注入口。每次再改照片框都能从同一公开案例复测，减少靠截图猜尺寸的误差。验收结果见 `verification.json`。
