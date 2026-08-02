# xrk-js — 真相源

> 本 repo 的**唯一**状态与待办来源。别处只能链接过来，不许另起清单。
> 最后更新：2026-08-03（首次建立，状态经实跑核对）

## 现在是什么状态

- **能跑吗**：能。`npm test` → **10 passed | 5 skipped**（2026-08-03 实跑）。
  **这就是预期结果，5 个 skip 不是失败**：`tests/golden.test.ts` 有 7 个 case，只有 2 个 fixture
  小到能进 repo，其余 5 个 `it.skipIf` 挂在 `XRK_TEST_DATA` 上。要跑满 15 个：
  ```bash
  git clone https://github.com/m3rlin45/libxrk /tmp/libxrk
  XRK_TEST_DATA=/tmp/libxrk/tests/test_data npm test   # → 15 passed
  ```
  看到除 `10 passed | 5 skipped`（或带环境变量时的 `15 passed`）以外的结果，才是真出问题了
- **跑在哪**：作为 npm 包被 [[aim2motec-web]] 依赖。
  **已发布：`aim-xrk@0.1.1`，latest（2026-08-03 `npm view` 实测）**
  （包名不是 `xrk-js`——被 npm 判定与 `xml-js` 过近而拒绝）
- **上次动它**：2026-07-13，`Fix Node ESM: add .js extensions to relative imports (v0.1.1)`
- **git**：`main`，与 origin 同步，工作区干净

## 待办

| 优先级 | 事项 | 不做会怎样 |
|---|---|---|
| P2 | memory 索引里仍写「publish blocked on repo-create permission」——**已发布，这条过期** | 下个 session 花时间去解决一个已经不存在的阻塞 |
| P2 | 本机 CI/日常没有设 `XRK_TEST_DATA`，5 个 golden case 长期不跑 | 真正的跨实现 parity 只在有人手动配环境时才被验证 |

已知局限有专门文件：**`LIMITATIONS.md`**（每条标 `[Design]` / `[Unimplemented]` / `[Format]` +
出处），解析行为有变动时要同步。本文件只放状态与待办。

## 已放弃（附原因，别再提）

- ~~用包名 `xrk-js` 发布~~ — npm 拒绝，理由是与 `xml-js` 过于相似。改名 `aim-xrk`。
  **本地目录名仍是 `xrk-js`，别把两者当成不一致的错误去"修"**

## 最近关掉的

- npm 发布 — `aim-xrk@0.1.1` 已是 latest（2026-08-03 `npm view aim-xrk version` 实测）
