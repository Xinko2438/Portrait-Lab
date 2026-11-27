# Portrait Lab 双图布局预览

2026-11-27。改前 Git 提交为 `68d42ef`。样式基线来自东京发布 `460ca3dea2b7773a63ea338982d620ba71477834b1e53df7fc94ad64220650f7` 的 `site/folio/portrait-lab/app.css`。本地候选目录的 `app.css` 记录本次样式，`site` 是同版本的可运行对照副本。此候选用于评审视觉取舍，正式发布使用项目现有构建与验证流程。

从本目录运行 `python -B -m http.server 4191 --bind 127.0.0.1 --directory site`。打开 http://127.0.0.1:4191/folio/portrait-lab/?run=run-demo-selected&from=history 。重建时复制该东京版的 Portrait Lab 目录到 `site/folio/portrait-lab`，运行 `node apply-preview.cjs`，将本地候选的 `index.html`、`app.js` 和样式应用到副本，同时刷新入口的缓存版本号。

## 同屏评审

当前本地候选从 c5f68e6（双视图）继续。候选照片以实际图片比例显示，评分、审美偏好、成片交付共享一个画布。右栏 A、B 列对应同名照片，支持 0–10 分的一位小数。笔形按钮打开批注，心形按钮记录、改选或撤销偏好；照片下勾选成片，底部明确确认后保存交付。参考图在同一行可随时打开。单图或不达标的候选保留原位置，同时按现有资格限制操作。此版本为本地演示；心形再次点击会在本地对比历史追加 clear 撤销标记，正式工作台接入时应先核对其对比接口。

执行 `node apply-preview.cjs` 将源码复制到本地演示，并更新静态入口版本。设置 PLAYWRIGHT_MODULE_PATH 并执行 `node verify-layout.cjs --capture`。脚本在独立浏览器数据中检查图片未裁切、两侧等宽、中缝与外边距比例；对改分、放大、批注、对比、交付、刷新恢复和资格撤销测量同一组照片坐标。结果为 verification.json，实测图为 preview-unified-review.png。历史版比较可从基线提交恢复。
