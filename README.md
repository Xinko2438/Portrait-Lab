# Portrait Lab 双图布局预览

2026-11-27。改前 Git 提交为 `68d42ef`。样式基线来自东京发布 `460ca3dea2b7773a63ea338982d620ba71477834b1e53df7fc94ad64220650f7` 的 `site/folio/portrait-lab/app.css`。本地候选目录的 `app.css` 记录本次样式，`site` 是同版本的可运行对照副本。此候选用于评审视觉取舍，正式发布使用项目现有构建与验证流程。

从本目录运行 `python -B -m http.server 4191 --bind 127.0.0.1 --directory site`。打开 http://127.0.0.1:4191/folio/portrait-lab/?run=run-demo-selected&from=history 。重建时复制该东京版的 Portrait Lab 目录到 `site/folio/portrait-lab`，运行 `node apply-preview.cjs`，将本地候选的 `index.html`、`app.js` 和样式应用到副本，同时刷新入口的缓存版本号。

## 滑条评审试用

- 新案例见 <http://127.0.0.1:4191/folio/portrait-lab/?run=run-demo-review&from=history>。
- 旧版交付案例见 <http://127.0.0.1:4191/folio/portrait-lab/?run=run-demo-selected&from=history>。
- 运行 `node apply-preview.cjs` 将候选同步到本地演示，评分流程及兼容回归使用 `node verify-layout.cjs --score-flow`。现有 `PLAYWRIGHT_MODULE_PATH` 设置仍适用。
- 依赖、验收和后续范围见 [评审机制改版计划](REVIEW-MECHANISM-PLAN.md)。
- 公网入口为 <https://xinko.link/folio/portrait-lab/?run=run-demo-review&from=history>。以 `PORTRAIT_REVIEW_ORIGIN` 指定其他验收环境。

## 同屏评审的原始候选

当前本地候选从 c5f68e6（双视图）继续。候选照片以实际图片比例显示，评分、审美偏好、成片交付共享一个画布。右栏 A、B 列对应同名照片，支持 0–10 分的一位小数。笔形按钮打开批注，心形按钮记录、改选或撤销偏好；照片下勾选成片，底部明确确认后保存交付。参考图在同一行可随时打开。单图或不达标的候选保留原位置，同时按现有资格限制操作。此版本为本地演示；心形再次点击会在本地对比历史追加 clear 撤销标记，正式工作台接入时应先核对其对比接口。

执行 `node apply-preview.cjs` 将源码复制到本地演示，并更新静态入口版本。设置 PLAYWRIGHT_MODULE_PATH 并执行 `node verify-layout.cjs --capture`。脚本在独立浏览器数据中检查图片未裁切、两侧等宽、中缝与外边距比例；对改分、放大、批注、对比、交付、刷新恢复和资格撤销测量同一组照片坐标。结果为 verification.json，实测图为 preview-unified-review.png。历史版比较可从基线提交恢复。

## 批注页顶部

2026-11-27。4191 的评审候选把批注标题、工具、状态和关闭合入同一顶栏。桌面同尺寸对比使用 1706×932 及 1366×768，画布起点从 163 移到 58 个 CSS 像素，照片可见高度各增加约 105 像素。390×844 时自动分两行，画布比原来提前约 50 像素开始。实测工具总数为 26，覆盖适合窗口、关闭、绘制、选中、保存和重开批注。可在新评审案例点第二张照片下方铅笔复看。截图为 preview-compact-annotation.png。

### 单图批注侧栏

4191 候选将桌面侧栏从 320 CSS 像素增至 350–460 CSS 像素，390 像素窗口仍为单列。默认显示区域操作提示、整图要求与保存，选中标记后显示类型和区域备注。继续修改入口按现有回调能力显示，并在可用的界面保留发送说明。重建使用 node apply-preview.cjs，批注编辑模块按内容更新缓存版本。

同尺寸实测 1706×932、1366×768、390×844，覆盖空态、区域编辑、整图要求、保存和重开。配置继续修改能力的测试检查了发送说明与保存前的禁用状态。验收截图为 preview-annotation-inspector.png。下次改侧栏，打开同一案例的第二图，比较可见编辑空间和区域控件的出现条件。

### 关闭图标与精简标题

4191 的七个顶部或边缘关闭控件使用同一个 × 图标，保留各自的可访问名称和悬停说明。重命名窗口顶部用关闭图标，底部的取消和保存仍表达表单动作。参考图预检、导入、历史记录、记录信息和重命名区移除了与标题重复的英文提示。入口仍为本地候选，源码与运行副本通过 node apply-preview.cjs 同步。

实测批注、图片预览、更多设置、API 生图配置和模板库的打开与关闭，另外验证模板详情只关闭侧栏、重命名窗口的顶部关闭、手机 44 像素触控范围，以及批注有未保存内容时的离开确认。后续检查同类控件可直接按按钮的可访问名称定位，再走一次打开、关闭和未保存状态。
