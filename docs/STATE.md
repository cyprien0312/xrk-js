# xrk-js — 真相源

> 本 repo 的**唯一**状态与待办来源。别处只能链接过来，不许另起清单。
> 最后更新：2026-09-29（GPS 时间戳重建改成相位展开，与 libxrk 0.13.0 对齐；见「最近关掉的」第一条）

## 现在是什么状态

- **能跑吗**：能。`npm test` → **32 passed | 9 skipped**（2026-09-29 Mac 实跑）。
  **这就是预期结果，9 个 skip 不是失败**：6 个外部 golden + issue84 时间戳核对挂在
  `XRK_TEST_DATA` 上，2 个 V4 测试挂在 `XRK_V4_SAMPLE`（本机 1 kHz 样本）上。跑满：
  ```bash
  git clone https://github.com/m3rlin45/libxrk /tmp/libxrk
  XRK_TEST_DATA=/tmp/libxrk/tests/test_data npm test   # → 39 passed | 2 skipped
  # 再加 XRK_V4_SAMPLE=<aim-analyzer>/data/Jason_r3_Broadford_Practice_a_0189.xrk → 41 passed
  ```
  看到别的数字才是真出问题了
- **跑在哪**：作为 npm 包被 [[aim2motec-web]] 依赖。
  **已发布：`aim-xrk@0.1.1`，latest（2026-08-03 `npm view` 实测）**
  （包名不是 `xrk-js`——被 npm 判定与 `xml-js` 过近而拒绝）
- **上次动它**：2026-09-29，GPS 时间戳重建（`src/gps.ts`），见下。**npm 上的 `aim-xrk@0.1.1` 还是旧规则，没发新版**
- **git**：`main`。`package-lock.json` 里包名 `xrk-js`→`aim-xrk` 的改动是早先 `npm install` 留下的，一直没提交

## 待办

| 优先级 | 事项 | 不做会怎样 |
|---|---|---|
| P2 | memory 索引里仍写「publish blocked on repo-create permission」——**已发布，这条过期** | 下个 session 花时间去解决一个已经不存在的阻塞 |
| P2 | 本机 CI/日常没有设 `XRK_TEST_DATA`，6 个外部 golden case 长期不跑 | 真正的跨实现 parity 只在有人手动配环境时才被验证 |
| P2 | 发 `aim-xrk@0.1.2`（带 2026-09-29 的 GPS 时间戳修复）——**要用户点头**，发布是对外动作 | [[aim2motec-web]] 走 npm 版，还在用会平移 GPS 的旧规则 |
| P3 | `fixGpsTimingGaps` 多次校正时的判据和 libxrk 0.13 不同（`LIMITATIONS.md` §4.6 末条） | 目前 129 个真实 log 没有一个触发两次以上校正，碰上才会分叉 |

已知局限有专门文件：**`LIMITATIONS.md`**（每条标 `[Design]` / `[Unimplemented]` / `[Format]` +
出处），解析行为有变动时要同步。本文件只放状态与待办。

## 已放弃（附原因，别再提）

- ~~用包名 `xrk-js` 发布~~ — npm 拒绝，理由是与 `xml-js` 过于相似。改名 `aim-xrk`。
  **本地目录名仍是 `xrk-js`，别把两者当成不一致的错误去"修"**

## 最近关掉的

- **GPS 时间戳重建改成相位展开（2026-09-29）**。旧规则（移植时的 libxrk 行为）把 GPS 记录时间戳的
  **任何**回退都当成 16 位回绕加 65536 ms，`fixGpsTimingGaps` 又只减回「缺口 − 40 ms」，
  回退之后整条 GPS 相对 logger 时钟通道平移。aim-analyzer 129 个真实 log 里 40 个中招（41 ms – 136 s），
  刹压领先 GPS 减速度最多 2.24 s（那边的 D14）；AiM 官方样例 `aim_official_test.xrk` 也偏了 4.7 s。
  上游 libxrk 0.13.0 已改成相位展开（`spec/docs/companion.md` §6），并在 issue84 上与 AiM 官方 DLL 逐条对拍。
  凭据：新增 `tests/gps-timecodes.test.ts`（12 个），issue84 加进 golden；三份受影响的 golden
  用 libxrk 0.13.0 重生成（只有 GPS 时间戳和 GPS 检测出的圈变了）；aim-analyzer 全部 129 个 log
  与 libxrk 0.13.0 的 GPS 时间戳和圈表逐条相同。细节 `LIMITATIONS.md` §4.5。

- npm 发布 — `aim-xrk@0.1.1` 已是 latest（2026-08-03 `npm view aim-xrk version` 实测）
