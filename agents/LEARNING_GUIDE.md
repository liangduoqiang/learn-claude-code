# AI 编程智能体（Agent）渐进式学习指南

> 本文档对应 `s01` ~ `s12` 共 12 个渐进式示例文件。
> 每个章节包含：核心理念、关键代码流程、重点技术解析。
> 建议按顺序阅读，每节对应一个 JS 文件实际运行和阅读。

---

## 总览：12 个阶段的演进路线

```
s01  Agent 循环          ← 整个系统的基础
s02  工具扩展            ← 能力扩展
s03  待办追踪            ← 自我管理
s04  子智能体            ← 上下文隔离 ★
s05  技能加载            ← 按需知识注入
s06  上下文压缩          ← 无限运行
s07  持久化任务          ← 跨压缩存活
s08  后台任务            ← 异步并行 ★★
s09  Agent 团队          ← Worker 线程 ★★★
s10  团队协议            ← 关闭 & 审批
s11  自主智能体          ← 自主寻工 ★★
s12  工作树隔离          ← 目录级隔离 ★★★
```

`★` 越多代表该节越是你重点关注的（后台进程、线程、Agent团队、工作树）。

---

## s01 — Agent 循环（核心基础）

### 核心理念

> **整个 AI Agent 的秘密就是一个 while 循环。**

```
while stop_reason == "tool_use":
    response = LLM(messages, tools)
    执行工具
    把工具结果追加到 messages
```

只要 LLM 还在调用工具，循环就继续；LLM 停止调用工具时，循环结束。

### 数据流

```
用户输入
    │
    ▼
messages = [{role:"user", content:"..."}]
    │
    ▼  ┌─────────────────────────────────────────────┐
    │  │  agentLoop(messages)                        │
    │  │                                             │
    │  │  1. client.messages.create(messages, tools) │
    │  │       ↓ response                            │
    │  │  2. messages.push(response.content)         │
    │  │       ↓                                     │
    │  │  3. if stop_reason != "tool_use": return    │
    │  │       ↓                                     │
    │  │  4. 执行工具 → output                       │
    │  │  5. messages.push(tool_result)              │
    │  │       ↓ 回到步骤 1                          │
    └──┘─────────────────────────────────────────────┘
```

### 关键代码（s01 第 76-106 行）

```javascript
async function agentLoop(messages) {
  while (true) {
    // 1. 调用 LLM（携带完整历史和工具）
    const response = await client.messages.create({ ... });

    // 2. 把回复追加到历史
    messages.push({ role: "assistant", content: response.content });

    // 3. 退出条件：不再调用工具
    if (response.stop_reason !== "tool_use") return;

    // 4. 执行所有工具调用
    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const output = runBash(block.input.command);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }

    // 5. 把工具结果喂回 LLM
    messages.push({ role: "user", content: results });
  }
}
```

### 要点

- `messages` 是完整的对话历史，每次都完整传给 LLM
- `tool_use_id` 必须与 LLM 请求中的 `block.id` 对应
- 安全措施：危险命令黑名单 + 120s 超时 + 50000字符截断

---

## s02 — 工具扩展

### 核心理念

> **循环完全没变，只是增加了工具。**

### 新增设计：工具派发表（Dispatch Map）

```javascript
const TOOL_HANDLERS = {
  bash:       ({ command }) => runBash(command),
  read_file:  ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file:  ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
};
```

**优势**：新增工具只需两步：① 在 `TOOL_HANDLERS` 加一行 ② 在 `TOOLS` 数组加描述。

### 安全设计：路径检查

```javascript
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}
```

防止 LLM 通过 `../../etc/passwd` 这样的路径访问工作区外的文件。

---

## s03 — 待办追踪（自我进度管理）

### 核心理念

> **Agent 可以追踪自己的进度——而且我们人类也能看到。**

### TodoManager 状态机

```
pending → in_progress → completed
              ↑ 约束：同一时刻只允许一个
```

### 催促提醒注入机制

```javascript
roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
if (roundsSinceTodo >= 3) {
  results.push({ type: "text", text: "<reminder>请更新你的待办列表。</reminder>" });
}
```

**技术意义**：通过向对话历史注入消息来引导 LLM 的行为，这是一种"软控制"技术。不用修改代码，只用修改消息。

---

## s04 — 子智能体（上下文隔离）★

### 核心理念

> **进程隔离 = 上下文隔离。子 Agent 工作完了，把结果给我，过程我不管。**

### 子 Agent vs 父 Agent 对比

| 属性 | 父 Agent | 子 Agent |
|------|---------|---------|
| 上下文 | 完整历史 `messages=[...]` | 空白开始 `messages=[]` |
| 工具 | 全部工具（含 task） | 基础工具（无 task） |
| 生命周期 | 持续运行 | 执行完毕即销毁 |
| 返回内容 | — | 只返回最终文本摘要 |

### 工作流程

```
父 Agent 收到任务
    │
    ▼ 调用 task 工具
runSubagent(prompt)
    │
    ├── 创建空白 subMessages = [{role:"user", content:prompt}]
    │
    ├── 运行子 Agent 循环（最多 30 轮）
    │   └── 只有基础工具，不能再派发子 Agent
    │
    ├── 子 Agent 完成工作
    │
    └── 只提取最后的文字摘要返回给父 Agent
        （中间过程全部丢弃，父 Agent 的上下文保持整洁）
```

### 关键代码（s04 第 171-205 行）

```javascript
async function runSubagent(prompt) {
  const subMessages = [{ role: "user", content: prompt }]; // 全新上下文！
  let response;

  for (let i = 0; i < 30; i++) {
    response = await client.messages.create({
      messages: subMessages,
      tools: CHILD_TOOLS,    // 过滤工具（无 task，防递归）
      ...
    });
    // ... 执行工具 ...
    if (response.stop_reason !== "tool_use") break;
  }

  // 只返回最终文字，中间所有 subMessages 被丢弃
  return response.content.filter(b => b.type === "text").map(b => b.text).join("");
}
```

### 适用场景

- 探索性任务（代码库分析、文档搜索）
- 有风险的实验（在隔离上下文中尝试）
- 并行化（多个子 Agent 同时工作）

---

## s05 — 技能加载（按需知识注入）

### 核心理念

> **不要把所有内容放进系统提示词。按需加载。**

### 两层注入架构

```
第一层（廉价）：系统提示词中列出技能名称
┌─────────────────────────────────────┐
│ 可用技能：                           │
│   - pdf: 处理 PDF 文件...           │ ← 每技能 ~100 token
│   - code-review: 代码审查...        │
└─────────────────────────────────────┘

第二层（按需）：LLM 调用 load_skill 时才注入完整内容
┌─────────────────────────────────────┐
│ tool_result:                        │
│ <skill name="pdf">                  │
│   完整的 PDF 处理说明                │ ← 只在需要时占用 token
│   步骤 1: ...                       │
│ </skill>                            │
└─────────────────────────────────────┘
```

### Token 经济学

| 方案 | 每次请求 token 开销 |
|------|-------------------|
| 全部放系统提示词 | 固定高开销（无论是否用到） |
| 两层按需加载 | 第一层（轻量）+ 第二层（只在用时）|

---

## s06 — 上下文压缩（无限运行）

### 核心理念

> **Agent 可以"选择性遗忘"来永久工作。**

### 三层压缩流水线

```
每轮执行顺序：

1. micro_compact（第一层，每轮静默）
   └── 把 3 轮前的工具结果替换为 "[上一步：使用了 bash]"
       例外：read_file 结果不压缩（有价值的参考内容）

2. 检查 token 数 > 50000？
   └── 是 → auto_compact（第二层）
         ├── 保存完整记录到 .transcripts/（用于审计）
         ├── 让 LLM 生成对话摘要
         └── 用摘要替换所有消息（messages 重新开始）

3. 模型调用 compact 工具？
   └── 是 → 触发 auto_compact（第三层，模型主动触发）
```

### 关键决策：什么该保留？

```javascript
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]); // 文件内容保留
// bash 的命令输出：可以压缩（下次还能重新执行）
// read_file 的内容：保留（重新读取需要额外开销）
```

### token 估算

```javascript
function estimateTokens(messages) {
  return JSON.stringify(messages).length / 4; // 1 token ≈ 4 字符
}
```

---

## s07 — 持久化任务系统

### 核心理念

> **状态存储在对话之外——因为它存在文件系统上。**

### 内存 vs 文件系统

| 存储位置 | 优点 | 缺点 |
|--------|------|------|
| LLM 上下文 | 随时可访问 | 压缩时丢失 |
| 内存变量 | 快速 | 进程重启丢失 |
| **文件系统** | **永久存在** | 稍慢 |

### 任务文件结构

```json
// .tasks/task_2.json
{
  "id": 2,
  "subject": "实现登录功能",
  "status": "pending",
  "blockedBy": [1],    // 被任务 1 阻塞，任务 1 完成后自动解除
  "owner": ""
}
```

### 依赖自动解除

```javascript
_clearDependency(completedId) {
  // 扫描所有任务，从 blockedBy 中移除已完成的任务 ID
  for (const f of files) {
    if (task.blockedBy.includes(completedId)) {
      task.blockedBy = task.blockedBy.filter(id => id !== completedId);
      this._save(task); // 自动解除阻塞
    }
  }
}
```

---

## s08 — 后台任务（异步并行执行）★★

### 核心理念

> **"发射后不管"——Agent 不会阻塞等待命令完成。**

### 同步 vs 异步执行

```
同步（bash）：
Agent → 执行命令 → 等待完成（阻塞） → 继续 → 执行命令 → 等待 → ...
       ←---120s---→                    ←---120s---→

异步（background_run）：
Agent → 启动命令A → 启动命令B → 做其他事 → 做其他事 → ...
              ↘              ↘
            A运行中          B运行中         （并行）
              ↘              ↘
          A完成→通知队列   B完成→通知队列
```

### 关键机制：通知队列

```javascript
class BackgroundManager {
  run(command) {
    const taskId = randomUUID().slice(0, 8);
    // exec() 是非阻塞的！立即返回
    exec(command, { timeout: 300000 }, (error, stdout, stderr) => {
      // 此回调在命令完成时被 Node.js 事件循环调用
      this._notificationQueue.push({ task_id: taskId, result: ... });
    });
    return `后台任务 ${taskId} 已启动`; // 立即返回
  }
}
```

### 通知消费（每次 LLM 调用前）

```javascript
async function agentLoop(messages) {
  while (true) {
    // 每轮开始，先消费后台通知
    const notifs = BG.drainNotifications();
    if (notifs.length > 0) {
      messages.push({
        role: "user",
        content: `<background-results>\n${notifs}\n</background-results>`
      });
    }
    // 然后才调用 LLM
    const response = await client.messages.create(...);
  }
}
```

### Node.js 事件循环理解

```
主线程（单线程）：
  ┌─── Event Loop ───────────────────────────────┐
  │  1. 接受用户输入                              │
  │  2. 调用 LLM（等待网络 I/O）                 │
  │  3. 处理 LLM 回复                            │
  │  4. 调用 exec()（非阻塞，委托给操作系统）     │
  │     └── OS 在后台执行命令                    │
  │  5. 继续其他工作                              │
  │  6. OS 命令完成 → 回调进入事件队列            │
  │  7. 事件循环处理回调 → 推入通知队列           │
  └──────────────────────────────────────────────┘
```

---

## s09 — Agent 团队（持久化协作）★★★

### 核心理念

> **可以互相通信的队员。不同于临时的子 Agent，队员持续存在并可以接收新消息。**

### 三种并发模式对比

| 模式 | 实现 | 生命周期 | 通信 | 适用场景 |
|------|------|---------|------|---------|
| 子 Agent（s04） | async 函数 | 一次性 | 只返回摘要 | 探索/隔离任务 |
| Worker 线程（s09） | Node.js Worker | 持久化 | JSONL 收件箱 | 长期并行协作 |
| 后台任务（s08） | exec() | 命令执行期间 | 通知队列 | 长时间运行命令 |

### Worker 线程架构

```
主进程（Lead）
  │
  ├── Worker 线程：alice
  │     ├── 自己的 Anthropic 客户端
  │     ├── 自己的对话历史
  │     └── 读写共享文件系统
  │
  ├── Worker 线程：bob
  │     ├── 自己的 Anthropic 客户端
  │     └── ...
  │
  └── 共享资源：
        ├── 文件系统（所有线程可读写）
        └── .team/inbox/（JSONL 消息文件）
```

### MessageBus：基于文件的消息系统

```
发送消息：
  lead → alice.jsonl（追加一行 JSON）
  {"type":"message","from":"lead","content":"...","timestamp":...}

接收消息：
  读取 alice.jsonl → 解析所有行 → 清空文件 → 返回消息数组
```

**为什么用文件而不是内存共享？**
- 持久化：Worker 崩溃后消息不丢失
- 多进程安全：`appendFileSync` 是原子操作
- 可观测性：可以直接查看 `inbox/` 目录了解通信状态

### 一个文件两种执行路径（关键模式）

```javascript
if (!isMainThread) {
  // Worker 线程：运行队员循环
  if (workerData?.isTeammate) {
    runTeammateLoop().catch(console.error);
  }
} else {
  // 主线程：运行 Lead Agent
  // ... Lead 的代码 ...
}
```

### Worker 生命周期

```
spawn_teammate("alice", "coder", "...")
       │
       ▼
new Worker(__filename, { workerData: { isTeammate: true, name:"alice", ... } })
       │
       ▼  Worker 线程开始执行
runTeammateLoop()
       │
       ├── 读收件箱
       ├── 调用 LLM
       ├── 执行工具（可以 send_message）
       └── stop_reason != "tool_use" → 任务完成
                   │
                   ▼
       parentPort.postMessage({ type: "done" })
                   │
       主线程监听到 → member.status = "idle"
```

---

## s10 — 团队协议（关闭 & 计划审批）

### 核心理念

> **相同的"请求 ID 关联"模式，应用于两个不同的业务场景。**

### 关闭协议（有限状态机）

```
状态：pending → approved | rejected

Lead                           队员
  │                              │
  ├──shutdown_request──────────► │
  │  {request_id: "abc123"}      │
  │                              │ 决策：同意？
  │ ◄────────shutdown_response── │
  │  {request_id: "abc123",      │
  │   approve: true}             │
  │                              │
  ▼                              ▼
shutdownRequests["abc123"]      shouldExit = true
  .status = "approved"          下轮退出循环
```

### 计划审批协议

```
队员                           Lead
  │                              │
  ├──plan_approval_response────► │
  │  {request_id: "def456",      │
  │   plan: "我打算重构登录..."}  │
  │                              │ 审阅计划
  │ ◄────────plan_approval────── │
  │  {request_id: "def456",      │
  │   approve: true,             │
  │   feedback: "注意考虑..."}   │
  │                              │
  ▼
继续执行计划（或调整）
```

### request_id 的作用

```javascript
// Lead 发起请求时生成
const reqId = crypto.randomUUID().slice(0, 8); // "abc12345"
shutdownRequests[reqId] = { target: "alice", status: "pending" };

// 队员响应时带上同一个 request_id
BUS.send(sender, "lead", reason, "shutdown_response", { request_id: reqId, approve: true });

// Lead 收到后找到原始请求并更新
shutdownRequests["abc12345"].status = "approved";
```

---

## s11 — 自主智能体（自主寻找工作）★★

### 核心理念

> **Agent 自己找工作。不需要 Lead 分配每一个任务。**

### 自主队员生命周期

```
                  ┌─────────────────────┐
                  │      工作阶段        │
                  │  LLM 调用工具        │
                  │  执行任务            │
                  └────────┬────────────┘
                           │
                  LLM 主动调用 idle 或
                  stop_reason != tool_use
                           │
                           ▼
                  ┌─────────────────────┐
                  │      空闲阶段        │
                  │  每 5 秒轮询一次    │
                  │  最多等 60 秒       │
                  └────────┬────────────┘
                           │
               ┌───────────┼──────────────┐
               │           │              │
               ▼           ▼              ▼
          有新消息？   有未认领任务？    60秒超时？
             │              │              │
          注入消息      自动认领任务       关闭
             │              │
             └──────┬───────┘
                    ▼
               恢复工作阶段
```

### 自动认领任务逻辑

```javascript
const unclaimed = scanUnclaimedTasks(tasksDir);
if (unclaimed.length > 0) {
  const task = unclaimed[0];
  const result = claimTask(task.id, name, tasksDir); // 原子操作

  if (!result.startsWith("错误:")) {
    // 认领成功：构造工作提示词
    messages.push({ role: "user", content:
      `<auto-claimed>任务 #${task.id}: ${task.subject}</auto-claimed>` });
    resume = true; // 恢复工作状态
  }
}
```

### 身份重注入（防"失忆"）

```javascript
function makeIdentityBlock(name, role, teamName) {
  return {
    role: "user",
    content: `<identity>你是 '${name}'，角色：${role}，团队：${teamName}。继续你的工作。</identity>`
  };
}

// 当对话历史很短时（可能是压缩后）注入身份块
if (messages.length <= 3) {
  messages.unshift(makeIdentityBlock(name, role, teamName));
}
```

**为什么需要身份重注入？**
- LLM 的记忆来自对话历史
- 上下文压缩后历史被清空
- 需要重新"提醒"LLM 它是谁、在做什么
- 类比：人从深度睡眠中醒来需要几秒钟才能想起自己在做什么

---

## s12 — 工作树隔离（目录级并行）★★★

### 核心理念

> **用目录隔离，用任务 ID 协调。**
> 每个工作树 = 独立的 git 分支 + 独立的工作目录

### 什么是 git worktree？

```bash
# 标准 git：一个仓库，一个工作目录
git checkout feature-a  # 切换分支（会丢失当前工作）

# git worktree：一个仓库，多个工作目录（同时检出多个分支）
git worktree add .worktrees/feature-a -b wt/feature-a HEAD
git worktree add .worktrees/feature-b -b wt/feature-b HEAD
# 现在可以同时在 feature-a 和 feature-b 上工作！
```

### 架构：控制平面 vs 执行平面

```
控制平面（任务板）          执行平面（工作树）
.tasks/task_12.json         .worktrees/auth-refactor/
{                           ├── src/           ← 独立代码副本
  "id": 12,                 ├── package.json
  "subject": "认证重构",    └── ...
  "worktree": "auth-refactor"  ↑
}                               │ 绑定关系

任务 → 知道"我在哪个工作树里工作"
工作树 → 知道"我对应哪个任务"
```

### 工作树生命周期

```
create                  active                  结束
  │                       │                      │
  ▼                       ▼                      ├── keep
worktree_create ──── worktree_run ──────────── 保留分支
(git worktree add)    在工作树中执行命令          │
                                                 └── remove
                                               git worktree remove
                                               可选：完成关联任务
```

### 可观测性：EventBus

```javascript
// 每个重要操作都记录到 events.jsonl
events.emit("worktree.create.before", { id: taskId }, { name, base_ref });
events.emit("worktree.create.after",  { id: taskId }, { name, path, branch });
events.emit("task.completed",         { id: taskId, subject }, { name });
```

**查询事件**：
```javascript
worktree_events({ limit: 20 })
// 返回最近 20 条生命周期事件，帮助理解系统状态
```

### 并行工作流程

```
Agent 接到"同时修复3个bug"的任务

1. task_create × 3（创建3个任务）
2. worktree_create × 3（为每个任务创建独立工作树）
3. worktree_run(name="fix-bug-1", command="...")  ← 在 bug1 的工作目录中执行
   worktree_run(name="fix-bug-2", command="...")  ← 在 bug2 的工作目录中执行
   worktree_run(name="fix-bug-3", command="...")  ← 在 bug3 的工作目录中执行
4. 检查每个工作树的状态
5. worktree_keep 或 worktree_remove（决策）
6. worktree_remove(complete_task=true) × 3（关闭并完成任务）
```

---

## 综合：四大关键主题深度解析

---

### 主题 1：后台进程与异步执行（s08）

**关键技术**：Node.js 的 `exec()` vs `execSync()`

```javascript
// execSync（同步/阻塞）：等待完成
const output = execSync("npm test"); // 卡在这里直到测试完成

// exec（异步/非阻塞）：立即返回
exec("npm test", (error, stdout) => {
  // 测试完成后这里被调用
  notificationQueue.push({ result: stdout });
});
// 这里立即继续执行！
```

**通知队列模式**：

```
后台命令完成 ──→ 推入 _notificationQueue
                        ↓
每次 LLM 调用前 ──→ drainNotifications() → 注入对话
```

**实际应用场景**：
- 运行测试（几分钟）
- 构建项目（几分钟到几十分钟）
- 下载依赖（网络 I/O）
- 多个命令并行执行

---

### 主题 2：Worker 线程与并发（s09、s11）

**为什么用 Worker 线程而不是子进程？**

| 特性 | Worker 线程 | 子进程 |
|-----|------------|-------|
| 内存 | 共享（通过 SharedArrayBuffer 等）| 隔离 |
| 通信 | postMessage()（快） | IPC 管道（慢） |
| 启动 | 快 | 慢 |
| 崩溃影响 | 不影响主进程 | 不影响主进程 |
| 文件系统 | 共享 | 共享 |
| 适用场景 | 并发 LLM 调用 | 需要完全隔离 |

**Worker 线程通信模式**：

```javascript
// 主线程：创建 Worker
const worker = new Worker(__filename, { workerData: { name: "alice", ... } });
worker.on("message", (msg) => {
  if (msg.type === "status") updateStatus(msg.status);
});

// Worker 线程：发消息给主线程
parentPort.postMessage({ type: "status", status: "idle" });
```

**一个文件同时作为主线程和 Worker 的技巧**：

```javascript
import { isMainThread, workerData, parentPort } from "worker_threads";

if (!isMainThread) {
  // Worker 线程执行路径
  runTeammateLoop();
} else {
  // 主线程执行路径
  startLeadAgent();
}
```

---

### 主题 3：Agent 团队架构（s09、s10、s11）

**团队通信拓扑**（以 s11 为例）：

```
                    Lead（主线程）
                        │
           ┌────────────┼────────────┐
           │            │            │
        Worker A     Worker B     Worker C
        (alice)      (bob)        (charlie)
           │            │
           ▼            ▼
      alice.jsonl  bob.jsonl    ← JSONL 收件箱文件
      lead.jsonl               ← Lead 的收件箱

通信规则：
  - 任何人可以给任何人发消息（通过收件箱文件）
  - 消息追加写入，异步投递
  - 读取后清空（消费模式）
```

**信息流动**（自主场景 s11）：

```
Lead
  1. spawn_teammate("alice", "backend") → 创建 Worker
  2. task_create("实现登录功能") → 写入 .tasks/

Alice（Worker线程）
  3. 空闲 → 扫描 .tasks/ → 发现未认领任务
  4. claim_task(1) → 设置 owner="alice", status="in_progress"
  5. 工作（调用 LLM，执行工具）
  6. 需要审批 → plan_approval → 发消息到 lead.jsonl
  7. 空闲轮询 → 发现审批结果 → 继续工作
  8. 完成 → send_message("lead", "任务完成")
  9. idle → 空闲 60 秒无事 → shutdown

Lead
  10. 收到 alice 的完成通知 → read_inbox
```

---

### 主题 4：工作树与任务隔离（s12）

**核心数据模型**：

```
任务（控制平面）              工作树（执行平面）
.tasks/task_N.json           .worktrees/<name>/
{                            ├── src/
  "worktree": "name"  ─────► └── ... （独立代码副本）
}

.worktrees/index.json        .worktrees/events.jsonl
{                            {"event":"worktree.create.after",...}
  "worktrees": [{            {"event":"task.completed",...}
    "name": "...",           （可观测性日志）
    "task_id": N,
    "status": "active"
  }]
}
```

**隔离的价值**：

```
没有工作树：
  修改 A 的代码 → 影响 B 的测试
  分支切换 → 需要 stash 或 commit

有工作树：
  .worktrees/fix-bug-1/ → 只有 bug1 的修改
  .worktrees/fix-bug-2/ → 只有 bug2 的修改
  互不干扰！各自独立测试！
```

**关闭工作树的两个选择**：

```javascript
// 删除（任务结束，分支不需要了）
worktree_remove({ name: "fix-bug-1", complete_task: true })
// ↑ 同时：1) git worktree remove  2) 任务状态→completed  3) 解除绑定

// 保留（任务结束，但分支有价值，需要 merge 或 review）
worktree_keep({ name: "auth-refactor" })
// ↑ 只更新索引状态，分支和目录还在
```

---

## s_full.js：完整系统汇总

`s_full.js` 是 s01 ~ s12 所有功能的合并版本，包含：
- 完整的 Agent 循环
- 全套工具（bash、文件操作、任务管理、工作树管理）
- 三层上下文压缩
- 技能加载
- 后台任务
- Worker 线程团队
- 关闭协议 & 计划审批协议
- 自主任务认领
- 事件总线

适合参考最终架构，不适合初学。

---

## 学习路径建议

### 快速入门路径（2小时）
1. 运行并理解 `s01` → 掌握 Agent 循环
2. 阅读 `s02` → 理解工具扩展
3. 跳至 `s08` → 理解后台任务

### 深入理解路径（1天）
1. `s01` → `s02` → `s03`（基础三件套）
2. `s04`（子 Agent，上下文隔离）
3. `s06`（上下文压缩，永久运行）
4. `s08`（后台任务，异步并行）
5. `s09`（Worker 线程团队）
6. `s12`（工作树隔离）

### 全栈掌握路径（2-3天）
按顺序 s01 → s12，每个文件都实际运行。

---

## 核心设计原则总结

| 原则 | 体现 | 文件 |
|------|------|------|
| 循环驱动 | while(tool_use) 循环 | s01 |
| 派发表 | {tool_name: handler} | s02 |
| 行为注入 | 向对话历史插入提醒/身份 | s03, s11 |
| 上下文隔离 | 子 Agent 用全新 messages | s04 |
| 按需加载 | 技能二层注入 | s05 |
| 选择性遗忘 | 三层压缩，保留重要内容 | s06 |
| 外部化状态 | 任务持久化到文件 | s07 |
| 非阻塞执行 | exec() + 通知队列 | s08 |
| 线程并发 | Worker 线程 + JSONL 收件箱 | s09-s11 |
| 协议设计 | request_id 关联 | s10 |
| 自主性 | 空闲轮询 + 自动认领 | s11 |
| 目录隔离 | git worktree | s12 |
| 可观测性 | EventBus + JSONL 事件日志 | s12 |

---

*文档生成时间：2026-05-18*
