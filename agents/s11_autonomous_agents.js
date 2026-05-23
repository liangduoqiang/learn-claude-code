#!/usr/bin/env node
// s11_autonomous_agents.js - 自主智能体（自主寻找工作）
//
// 空闲循环：轮询任务板、自动认领未分配任务、
// 上下文压缩后重新注入身份信息。基于 s10 的协议构建。
//
//     队员生命周期：
//     +-------+
//     | 派生  |
//     +---+---+
//         |
//         v
//     +-------+  tool_use    +-------+
//     | 工作  | <----------- |  LLM  |
//     +---+---+              +-------+
//         |
//         | stop_reason != tool_use
//         v
//     +--------+
//     | 空闲   | 每 5 秒轮询一次，最多 60 秒
//     +---+----+
//         |
//         +---> 检查收件箱 → 有消息？→ 恢复工作
//         |
//         +---> 扫描 .tasks/ → 有未认领任务？→ 认领 → 恢复工作
//         |
//         +---> 超时（60秒）→ 关闭
//
//     上下文压缩后重新注入身份：
//     messages = [identity_block, ...剩余消息...]
//     "你是 'coder'，角色：backend，团队：my-team"
//
// 【核心理念】Agent 自己找工作。
//             不需要 Lead 分配每一个任务，Agent 主动扫描任务板并认领。
//             这实现了真正的自主性。
//
// 【关键新特性对比 s10】
//   1. idle 工具：Agent 主动声明"我没有工作了"，进入轮询等待
//   2. claim_task 工具：Agent 主动从任务板认领任务
//   3. 自动认领：空闲期间扫描到未认领任务时自动认领
//   4. 身份重注入：防止长期运行中 Agent 忘记自己的身份

import { createLlmClient, getModel } from "./llm_client.js";
import { createFlowContext, flowOnce } from "./exec_flow.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const MODEL = getModel();

// =====================================================================
// 【生产化配置】可由环境变量覆盖
// =====================================================================
const POLL_INTERVAL_MS   = num(process.env.S11_POLL_INTERVAL_MS, 5000);     // 基础轮询间隔
const POLL_BACKOFF_MAX   = num(process.env.S11_POLL_BACKOFF_MAX, 30000);    // 指数退避上限
const IDLE_TIMEOUT_MS    = num(process.env.S11_IDLE_TIMEOUT_MS, 300000);    // 软超时：5 分钟无事 → shutdown
const WORK_MAX_ITERATIONS = num(process.env.S11_WORK_MAX_ITER, 50);         // 工作阶段最大轮次
const STALE_TASK_MS      = num(process.env.S11_STALE_TASK_MS, 300000);      // 任务心跳超过 5 分钟视为僵尸
const MAX_INBOX_BYTES    = num(process.env.S11_MAX_INBOX_BYTES, 5_000_000); // 单 inbox 文件超过则 rotate
const LLM_RETRIES        = num(process.env.S11_LLM_RETRIES, 3);
const LLM_RETRY_BASE_MS  = num(process.env.S11_LLM_RETRY_BASE_MS, 1000);
const SHUTDOWN_GRACE_MS  = num(process.env.S11_SHUTDOWN_GRACE_MS, 10000);   // 优雅停机超时
const IDENTITY_REMIND_EVERY = num(process.env.S11_IDENTITY_REMIND_EVERY, 8);// 每 N 个工具轮次重注入身份

function num(v, def) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }

// 协议级消息类型枚举
//   plan_approval_request：队员→Lead 提交计划等待审批
//   plan_approval_response：Lead→队员 反馈批准/拒绝
const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_request",
  "plan_approval_response",
  "status_update",
]);


// =====================================================================
// 【路径/输入安全】杜绝 LLM 通过工具参数越界
// =====================================================================
const NAME_RE = /^[a-zA-Z0-9_\-]{1,64}$/;
function safeMember(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`非法成员名：${JSON.stringify(name)}（仅允许 [a-zA-Z0-9_-]）`);
  }
  return name;
}
function safeTaskId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) {
    throw new Error(`非法任务 ID：${JSON.stringify(id)}`);
  }
  return n;
}


// =====================================================================
// 【原子文件操作】所有 JSON 持久化都走 tmp + rename，避免写入中断破坏文件
// =====================================================================
function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return { __error: e.message };
  }
}


// =====================================================================
// 【O_EXCL 文件锁】Node 内置实现的跨进程互斥
//
// 临界区要短：占锁 → 读 → 改 → 写 → 释放。锁文件中写入持有者信息便于排查。
// 自带"陈旧锁回收"：锁文件 mtime 超过 STALE_MS 视为遗弃，强制接管。
// =====================================================================
function withFileLock(lockPath, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const start = Date.now();
  const owner = `${process.pid}:${randomUUID().slice(0, 6)}`;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, owner);
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        try { fs.unlinkSync(lockPath); } catch { /* 已被回收 */ }
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 锁已存在：检查是否陈旧
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* 锁刚被释放，重试即可 */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`获取锁超时：${lockPath}`);
      }
      // 短暂忙等（同步代码内只能 sleep）
      const until = Date.now() + 20 + Math.floor(Math.random() * 30);
      while (Date.now() < until) { /* spin 20-50ms */ }
    }
  }
}


// =====================================================================
// 【可中断 sleep】fs.watch 等事件能在睡眠中提前唤醒
//
// 用法：const ctrl = new AbortController(); sleep(5000, ctrl.signal);
// 然后在收件箱有新消息时 ctrl.abort() 即可立即唤醒。
// =====================================================================
function sleepInterruptible(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("aborted");
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("timeout");
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve("aborted");
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}


// =====================================================================
// 【LLM 重试包装】网络抖动、429 不再让 Worker 当场自杀
// =====================================================================
async function callLlmWithRetry(client, payload, flowCtx) {
  let lastErr;
  for (let i = 0; i <= LLM_RETRIES; i++) {
    try {
      return await client.messages.create(payload);
    } catch (e) {
      lastErr = e;
      const backoff = LLM_RETRY_BASE_MS * Math.pow(2, i) + Math.floor(Math.random() * 200);
      flowCtx?.infra("LLM 调用失败", { attempt: i + 1, max: LLM_RETRIES + 1, err: e.message, backoffMs: backoff });
      if (i === LLM_RETRIES) break;
      await sleepInterruptible(backoff);
    }
  }
  throw lastErr;
}


// =====================================================================
// 【生产化 MessageBus】append-only + offset 游标
//
// 关键变化（对比 s09/s10/s11 原版）：
//   1. 不再 read→truncate（这会丢消息）。改为 append-only + 游标文件记录已消费偏移。
//   2. 每条消息附 id (uuid) / timestamp_ms / seq，便于幂等、追溯。
//   3. 单条写入用 O_APPEND（POSIX 原子追加，多 Worker 并发 send 安全）。
//   4. JSON 损坏行不阻塞整个 inbox，记录后跳过。
//   5. inbox 文件超过 MAX_INBOX_BYTES 自动 rotate 到 .1（仅保留 1 个历史版本）。
//   6. 提供 peek/consume 两套语义；触发器（abortController）用于事件唤醒。
// =====================================================================
class MessageBus {
  constructor(inboxDir) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._seq = 0;
  }

  _inboxPath(name) { return path.join(this.dir, `${safeMember(name)}.jsonl`); }
  _cursorPath(name) { return path.join(this.dir, `${safeMember(name)}.cursor`); }

  _readCursor(name) {
    try {
      const v = fs.readFileSync(this._cursorPath(name), "utf8").trim();
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }
  }

  _writeCursor(name, offset) {
    const p = this._cursorPath(name);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, String(offset));
    fs.renameSync(tmp, p);
  }

  _rotateIfNeeded(inboxPath, cursorOffset) {
    let size;
    try { size = fs.statSync(inboxPath).size; } catch { return; }
    if (size < MAX_INBOX_BYTES) return;
    // 安全前提：已全部消费完（cursorOffset === size）才 rotate；否则会丢未读
    if (cursorOffset < size) return;
    const rotated = `${inboxPath}.1`;
    try { fs.renameSync(inboxPath, rotated); } catch { /* ignore */ }
    try { fs.unlinkSync(`${inboxPath}.cursor`); } catch { /* ignore */ }
    flowOnce("s11", "inbox rotate", { inboxPath, size });
  }

  send(sender, to, content, msgType = "message", extra = null) {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return { ok: false, error: `无效消息类型 '${msgType}'。有效类型：${[...VALID_MSG_TYPES].join(", ")}` };
    }
    let toSafe;
    try { toSafe = safeMember(to); } catch (e) { return { ok: false, error: e.message }; }

    const msg = {
      id: randomUUID(),
      seq: ++this._seq,
      type: msgType,
      from: sender,
      to: toSafe,
      content,
      timestamp_ms: Date.now(),
      ...(extra || {}),
    };
    const inboxPath = this._inboxPath(toSafe);
    // O_APPEND 保证多 Worker 并发追加不交错（消息体 < PIPE_BUF）
    const fd = fs.openSync(inboxPath, "a");
    try {
      fs.writeSync(fd, JSON.stringify(msg) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    flowOnce("s11", "收件箱写入", { to: toSafe, type: msgType, id: msg.id });
    return { ok: true, message: `已发送 ${msgType} 给 ${toSafe}`, id: msg.id };
  }

  // 内部读取：根据 advance 决定是否推进 cursor
  _read(nameSafe, { advance }) {
    const inboxPath = this._inboxPath(nameSafe);
    if (!fs.existsSync(inboxPath)) return { messages: [], size: 0 };
    const offset = this._readCursor(nameSafe);
    const stat = fs.statSync(inboxPath);
    if (stat.size <= offset) {
      if (advance) this._rotateIfNeeded(inboxPath, offset);
      return { messages: [], size: stat.size };
    }

    const fd = fs.openSync(inboxPath, "r");
    let buf;
    try {
      const len = stat.size - offset;
      buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, offset);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    const messages = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        flowOnce("s11", "inbox 损坏行跳过", { name: nameSafe, err: e.message, sample: line.slice(0, 120) });
      }
    }
    if (advance) {
      this._writeCursor(nameSafe, stat.size);
      if (messages.length) {
        flowOnce("s11", "收件箱消费", { name: nameSafe, count: messages.length });
      }
      this._rotateIfNeeded(inboxPath, stat.size);
    }
    return { messages, size: stat.size };
  }

  // 读取自上次消费以来的新消息，并推进游标（真正消费）。
  // LLM 通过 read_inbox 工具调用走这条路径。
  readInbox(name) {
    let nameSafe;
    try { nameSafe = safeMember(name); } catch { return []; }
    return this._read(nameSafe, { advance: true }).messages;
  }

  // 只看不消费。系统层用来检测 shutdown_request、判断是否有新消息以提示 LLM。
  // 这样 LLM 调 read_inbox 时永远能拿到真实消息，而不会因系统自动消费造成"邮箱永远是空的"。
  peekInbox(name) {
    let nameSafe;
    try { nameSafe = safeMember(name); } catch { return { messages: [], size: 0 }; }
    return this._read(nameSafe, { advance: false });
  }

  // 广播：跳过自己；可选过滤离线成员
  broadcast(sender, content, teammates, { skipOffline = true, statusOf } = {}) {
    let count = 0;
    for (const name of teammates) {
      if (name === sender) continue;
      if (skipOffline && statusOf && ["shutdown", "error"].includes(statusOf(name))) continue;
      this.send(sender, name, content, "broadcast");
      count++;
    }
    return { ok: true, message: `已广播给 ${count} 个队员` };
  }
}


// =====================================================================
// 【生产化 TaskBoard】（取代 scanUnclaimedTasks / claimTask）
//
// 关键变化：
//   1. 认领走 O_EXCL 文件锁 → 真正的原子操作。两个 Worker 同时抢同一任务，
//      只有一个能成功，另一个收到结构化错误而不是数据损坏。
//   2. 任务字段扩展：createdAt/claimedAt/heartbeatAt/completedAt/attempts/maxAttempts/lastError。
//   3. 心跳与僵尸回收：Worker 工作期间定期更新 heartbeatAt；
//      扫描时若发现 in_progress 任务的心跳超过 STALE_TASK_MS，
//      自动归还到 pending 并增加 attempts。
//   4. 所有方法返回结构化对象 { ok, ... }，告别 startsWith('错误:') 字符串嗅探。
//   5. JSON 损坏文件不阻塞整体扫描，单独记录。
//   6. 写入用 atomicWriteJson（tmp + rename）。
// =====================================================================
const TASK_FILE_RE = /^task_(\d+)\.json$/;
const TASK_LOCK_NAME = ".taskboard.lock";

function listTaskFiles(tasksDir) {
  fs.mkdirSync(tasksDir, { recursive: true });
  return fs.readdirSync(tasksDir)
    .filter((f) => TASK_FILE_RE.test(f))
    .sort((a, b) => parseInt(a.match(TASK_FILE_RE)[1]) - parseInt(b.match(TASK_FILE_RE)[1]));
}

function taskPath(tasksDir, id) { return path.join(tasksDir, `task_${safeTaskId(id)}.json`); }

// 单文件读取，容错；返回 null 表示该文件不可读
function loadTask(tasksDir, id) {
  const fp = taskPath(tasksDir, id);
  if (!fs.existsSync(fp)) return null;
  const t = readJsonSafe(fp);
  if (t.__error) {
    flowOnce("s11", "任务文件损坏", { id, err: t.__error });
    return null;
  }
  return t;
}

// 扫描所有任务并在扫描期间顺手回收僵尸任务（心跳超时）。
// 返回 unclaimed 列表（可立即被认领的）+ 顺带恢复的僵尸数量。
function scanTasks(tasksDir, { reviveStale = true } = {}) {
  const now = Date.now();
  const files = listTaskFiles(tasksDir);
  const unclaimed = [];
  let revived = 0;
  for (const file of files) {
    const fp = path.join(tasksDir, file);
    const t = readJsonSafe(fp);
    if (t.__error) {
      flowOnce("s11", "任务文件损坏跳过", { file, err: t.__error });
      continue;
    }
    // 僵尸回收：in_progress 且超过 STALE_TASK_MS 没心跳。
    // 必须在锁内执行，避免和 claim/heartbeat 并发交错（先认领后被误回收）。
    if (
      reviveStale &&
      t.status === "in_progress" &&
      t.heartbeatAt && now - t.heartbeatAt > STALE_TASK_MS &&
      (t.attempts || 0) < (t.maxAttempts || 3)
    ) {
      const lockPath = path.join(tasksDir, TASK_LOCK_NAME);
      try {
        withFileLock(lockPath, () => {
          // 再次校验：拿到锁之后状态可能已变化（被新心跳救回 / 被完成）
          const fresh = loadTask(tasksDir, t.id);
          if (!fresh) return;
          if (fresh.status !== "in_progress") return;
          if (fresh.heartbeatAt && Date.now() - fresh.heartbeatAt <= STALE_TASK_MS) return;
          if ((fresh.attempts || 0) >= (fresh.maxAttempts || 3)) {
            fresh.status = "failed";
            fresh.lastError = `重试次数耗尽（${fresh.attempts}/${fresh.maxAttempts || 3}）`;
            atomicWriteJson(fp, fresh);
            flowOnce("s11", "僵尸任务标记失败", { id: fresh.id });
            return;
          }
          fresh.status = "pending";
          fresh.owner = "";
          fresh.attempts = (fresh.attempts || 0) + 1;
          fresh.lastError = `心跳超时被回收（${Math.round((Date.now() - fresh.heartbeatAt) / 1000)}s 无心跳）`;
          atomicWriteJson(fp, fresh);
          revived++;
          flowOnce("s11", "僵尸任务回收", { id: fresh.id, attempts: fresh.attempts });
        }, { timeoutMs: 2000 });
      } catch (e) {
        flowOnce("s11", "僵尸任务回收失败", { id: t.id, err: e.message });
      }
    }
    const blocked = Array.isArray(t.blockedBy) ? t.blockedBy : [];
    if (t.status === "pending" && !t.owner && blocked.length === 0) {
      unclaimed.push(t);
    }
  }
  if (revived) flowOnce("s11", "扫描完成：回收僵尸", { revived });
  return unclaimed;
}

// 原子认领：占锁 → 加载 → 校验 → 写回 → 释放锁
function claimTask(tasksDir, id, owner) {
  const lockPath = path.join(tasksDir, TASK_LOCK_NAME);
  fs.mkdirSync(tasksDir, { recursive: true });
  let result;
  try {
    result = withFileLock(lockPath, () => {
      const t = loadTask(tasksDir, id);
      if (!t) return { ok: false, code: "not_found", error: `任务 ${id} 不存在或损坏` };
      if (t.owner) return { ok: false, code: "already_claimed", error: `任务 ${id} 已被 ${t.owner} 认领` };
      if (t.status !== "pending") return { ok: false, code: "bad_status", error: `任务 ${id} 状态为 '${t.status}'，无法认领` };
      const blocked = Array.isArray(t.blockedBy) ? t.blockedBy : [];
      if (blocked.length) return { ok: false, code: "blocked", error: `任务 ${id} 被 ${JSON.stringify(blocked)} 阻塞` };

      t.owner = owner;
      t.status = "in_progress";
      t.claimedAt = Date.now();
      t.heartbeatAt = Date.now();
      atomicWriteJson(taskPath(tasksDir, id), t);
      flowOnce("s11", "任务认领", { id, owner, subject: t.subject });
      return { ok: true, task: t, path: taskPath(tasksDir, id) };
    }, { timeoutMs: 5000, staleMs: 30000 });
  } catch (e) {
    return { ok: false, code: "lock_failed", error: e.message };
  }
  return result;
}

// 仅持有者可更新心跳；防止误操作他人任务
function heartbeatTask(tasksDir, id, owner) {
  const lockPath = path.join(tasksDir, TASK_LOCK_NAME);
  try {
    return withFileLock(lockPath, () => {
      const t = loadTask(tasksDir, id);
      if (!t) return { ok: false, error: "任务不存在" };
      if (t.owner !== owner) return { ok: false, error: "非任务持有者" };
      t.heartbeatAt = Date.now();
      atomicWriteJson(taskPath(tasksDir, id), t);
      return { ok: true };
    }, { timeoutMs: 2000 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 完成/失败任务：自动解除依赖（参考 s07 的 _clearDependency）
function completeTask(tasksDir, id, owner, { success = true, note = "" } = {}) {
  const lockPath = path.join(tasksDir, TASK_LOCK_NAME);
  try {
    return withFileLock(lockPath, () => {
      const t = loadTask(tasksDir, id);
      if (!t) return { ok: false, error: "任务不存在" };
      if (t.owner !== owner) return { ok: false, error: "非任务持有者" };
      t.status = success ? "completed" : "failed";
      t.completedAt = Date.now();
      if (note) t.note = note;
      atomicWriteJson(taskPath(tasksDir, id), t);
      // 解除其他任务对它的依赖
      if (success) {
        for (const file of listTaskFiles(tasksDir)) {
          const fp = path.join(tasksDir, file);
          const other = readJsonSafe(fp);
          if (other.__error) continue;
          if (Array.isArray(other.blockedBy) && other.blockedBy.includes(t.id)) {
            other.blockedBy = other.blockedBy.filter((x) => x !== t.id);
            atomicWriteJson(fp, other);
          }
        }
      }
      flowOnce("s11", "任务完成", { id: t.id, success });
      return { ok: true, task: t };
    }, { timeoutMs: 5000 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function createTask(tasksDir, subject, description = "", blockedBy = []) {
  const lockPath = path.join(tasksDir, TASK_LOCK_NAME);
  try {
    return withFileLock(lockPath, () => {
      const files = listTaskFiles(tasksDir);
      const maxId = files.length ? Math.max(...files.map((f) => parseInt(f.match(TASK_FILE_RE)[1]))) : 0;
      const task = {
        id: maxId + 1,
        subject: String(subject),
        description: String(description || ""),
        status: "pending",
        owner: "",
        blockedBy: Array.isArray(blockedBy) ? blockedBy.map(safeTaskId) : [],
        attempts: 0,
        maxAttempts: 3,
        createdAt: Date.now(),
        claimedAt: 0,
        heartbeatAt: 0,
        completedAt: 0,
      };
      atomicWriteJson(taskPath(tasksDir, task.id), task);
      flowOnce("s11", "任务创建", { id: task.id, subject: task.subject });
      return { ok: true, task };
    }, { timeoutMs: 5000 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listTasksSummary(tasksDir) {
  const files = listTaskFiles(tasksDir);
  if (!files.length) return "暂无任务。";
  const lines = [];
  for (const file of files) {
    const t = readJsonSafe(path.join(tasksDir, file));
    if (t.__error) { lines.push(`[?] ${file}: 损坏`); continue; }
    const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]", failed: "[!]" }[t.status] || "[?]";
    const owner = t.owner ? ` @${t.owner}` : "";
    const blocked = Array.isArray(t.blockedBy) && t.blockedBy.length ? ` (被阻塞:${JSON.stringify(t.blockedBy)})` : "";
    lines.push(`${marker} #${t.id}: ${t.subject}${owner}${blocked}`);
  }
  return lines.join("\n");
}


// =====================================================================
// 身份重注入块
//
// 当 Agent 长时间运行或上下文被压缩后，可能"忘记"自己的身份。
// 改进点（对比原版）：
//   - 不再用 `messages.length <= 3` 这种正常运行下永远进不去的条件。
//   - 改为"距离上次注入 >= IDENTITY_REMIND_EVERY 个工具轮次时再注入"。
//   - 始终插在末尾的 user 位置，避免破坏 OpenAI 的 user/assistant 轮换约束。
// =====================================================================
function makeIdentityBlock(name, role, teamName) {
  return {
    role: "user",
    content: `<identity>你是 '${name}'，角色：${role}，团队：${teamName}。继续你的工作。</identity>`,
  };
}


// 基础工具实现
function safePath(p, workdir) {
  const base = workdir || WORKDIR;
  const resolved = path.resolve(base, p);
  if (!resolved.startsWith(base)) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

function runBash(command, workdir) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) {
    return "错误：危险命令已被拦截";
  }
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: workdir || WORKDIR,
      timeout: 120000,
      encoding: "utf8",
    });
    const out = ((result.stdout || "") + (result.stderr || "")).trim();
    return (out || "(无输出)").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runRead(filePath, limit, workdir) {
  try {
    const lines = fs.readFileSync(safePath(filePath, workdir), "utf8").split("\n");
    const result =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runWrite(filePath, content, workdir) {
  try {
    const fp = safePath(filePath, workdir);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `已写入 ${content.length} 字节`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runEdit(filePath, oldText, newText, workdir) {
  try {
    const fp = safePath(filePath, workdir);
    const c = fs.readFileSync(fp, "utf8");
    if (!c.includes(oldText)) return `错误：在 ${filePath} 中未找到指定文本`;
    fs.writeFileSync(fp, c.replace(oldText, newText));
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

// 用作工具调用结果展示：把结构化对象转为易读字符串
function fmtResult(r) {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    if (r.ok === false) return `错误：${r.error || JSON.stringify(r)}`;
    if (r.ok === true) {
      // 优雅展示成功结果（隐藏 ok 字段冗余）
      const { ok: _ok, ...rest } = r;
      return JSON.stringify(rest, null, 2);
    }
  }
  return String(r);
}


// =====================================================================
// 【Worker 线程入口】自主队员循环（生产化版本）
//
// 关键改进：
//   1. 空闲轮询用 fs.watch 监听 inbox 与任务板变化 → 事件驱动唤醒；
//      sleep 期间被 abort 后立即检查，最大延迟从原本 5s 降到 ~ms 级。
//   2. 指数退避：连续 N 次轮询无事，间隔从 POLL_INTERVAL_MS 增长至 POLL_BACKOFF_MAX，
//      减少 CPU/IO 浪费。一旦发生事件立即重置回 base。
//   3. LLM 调用走 callLlmWithRetry：网络抖动不再让 Worker 自杀。
//      若所有重试均失败 → 上报 status=error 让 Lead 知情，并不退出而是回到空闲。
//   4. 任务心跳：每个工具轮次结束后，自动给当前持有任务发心跳，避免被僵尸回收。
//   5. 身份重注入：按工具轮次计数器周期性插入，保证 user/assistant 顺序合法。
//   6. 工作阶段最多 WORK_MAX_ITERATIONS 轮后主动转空闲（防止失控刷 LLM）。
//   7. claim 现在返回 { ok, ... } 对象，告别字符串嗅探的隐式 bug。
//   8. 持有 currentTaskId，工作完成时显式调 complete_task 工具。
// =====================================================================
async function runTeammateLoop() {
  const {
    name, role, prompt, workdir, inboxDir, tasksDir,
    model, baseUrl, apiKey, teamName,
  } = workerData;
  const mateFlow = createFlowContext(`s11:worker:${name}`);
  mateFlow.phase("自主队员启动", JSON.stringify({ role, teamName }));

  const client = createLlmClient({ baseUrl, apiKey });
  const bus = new MessageBus(inboxDir);

  // 当前 Worker 持有的任务 ID（用于心跳与完成回调）
  let currentTaskId = null;
  // 工具轮次计数器（用于身份重注入）
  let toolRoundCounter = 0;

  const sysPrompt =
    `你是 '${name}'，角色：${role}，团队：${teamName}，工作在 ${workdir}。\n` +
    `工作流程（按优先级）：\n` +
    `0. 如果看到 <wake>...</wake> 提示，必须立刻调用 read_inbox 工具读取消息并处理。\n` +
    `   收到 shutdown_request 时用 shutdown_response 响应。\n` +
    `1. 没有消息要处理时，调用 scan_unclaimed_tasks 查看任务板。\n` +
    `2. 根据 task_id 调用 claim_task 领取任务（返回 ok=false 时换一个）。\n` +
    `3. 完成任务后调用 complete_task 标记完成；如失败调用 complete_task 并传 success=false。\n` +
    `4. 没有可领任务时调用 idle 进入空闲，由系统自动唤醒。\n` +
    `不要闲聊；优先级：shutdown_request > 收件箱消息 > 当前任务 > 扫描新任务。`;

  const messages = prompt ? [{ role: "user", content: prompt }] : [];

  // 队员工具集
  const TEAMMATE_TOOLS = [
    { name: "bash", description: "执行 shell 命令。",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "读取文件内容。",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "write_file", description: "将内容写入文件。",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file", description: "精确替换文件中的指定文本。",
      input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "send_message", description: "向队员发送消息。",
      input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "读取自己的收件箱（推进游标，不会丢消息）。",
      input_schema: { type: "object", properties: {} } },
    { name: "shutdown_response", description: "响应 Lead 的关闭请求。",
      input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
    { name: "plan_approval", description: "向 Lead 提交计划请求审批。",
      input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
    { name: "idle", description: "声明没有更多工作。进入空闲事件等待。",
      input_schema: { type: "object", properties: {} } },
    { name: "claim_task", description: "按 ID 从任务板认领任务（原子操作，返回结构化结果）。",
      input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    { name: "complete_task", description: "完成当前持有的任务。失败时 success=false。",
      input_schema: { type: "object", properties: { task_id: { type: "integer" }, success: { type: "boolean" }, note: { type: "string" } }, required: ["task_id"] } },
    { name: "scan_unclaimed_tasks", description: "扫描任务板，返回所有可立即认领的任务。",
      input_schema: { type: "object", properties: {} } },
  ];

  function execTeammateTool(toolName, args) {
    try {
      if (toolName === "bash")       return runBash(args.command, workdir);
      if (toolName === "read_file")  return runRead(args.path, null, workdir);
      if (toolName === "write_file") return runWrite(args.path, args.content, workdir);
      if (toolName === "edit_file")  return runEdit(args.path, args.old_text, args.new_text, workdir);
      if (toolName === "send_message")
        return bus.send(name, args.to, args.content, args.msg_type || "message");
      if (toolName === "read_inbox")
        return JSON.stringify(bus.readInbox(name), null, 2);
      if (toolName === "shutdown_response") {
        const reqId = args.request_id;
        parentPort.postMessage({ type: "shutdown_response", reqId, approve: args.approve });
        bus.send(name, "lead", args.reason || "", "shutdown_response", {
          request_id: reqId, approve: args.approve,
        });
        return `关闭${args.approve ? "已批准" : "已拒绝"}`;
      }
      if (toolName === "plan_approval") {
        const reqId = randomUUID().slice(0, 8);
        const planText = args.plan || "";
        parentPort.postMessage({ type: "plan_submitted", reqId, from: name, plan: planText });
        // 修复：用 plan_approval_request 类型（原版误用了 _response）
        bus.send(name, "lead", planText, "plan_approval_request", {
          request_id: reqId, plan: planText,
        });
        return `计划已提交（request_id=${reqId}）。等待审批。`;
      }
      if (toolName === "claim_task") {
        const id = safeTaskId(args.task_id);
        const r = claimTask(tasksDir, id, name);
        if (r.ok) currentTaskId = r.task.id;
        return r;
      }
      if (toolName === "complete_task") {
        const id = safeTaskId(args.task_id);
        const r = completeTask(tasksDir, id, name, {
          success: args.success !== false,
          note: args.note || "",
        });
        if (r.ok && currentTaskId === id) currentTaskId = null;
        return r;
      }
      if (toolName === "scan_unclaimed_tasks") {
        const list = scanTasks(tasksDir);
        return JSON.stringify(list.map((t) => ({
          id: t.id, subject: t.subject, attempts: t.attempts || 0,
        })), null, 2);
      }
      return `未知工具：${toolName}`;
    } catch (e) {
      return `错误：${e.message}`;
    }
  }

  // === 文件监视器：inbox 和任务板变化时唤醒空闲循环 ===
  function setupWatchers(abortController) {
    const watchers = [];
    const wake = (reason) => {
      mateFlow.infra("事件唤醒", { reason });
      abortController.abort();
    };
    try {
      const w1 = fs.watch(inboxDir, { persistent: false }, (event, file) => {
        // 只关心自己的 inbox 变化
        if (file && file.startsWith(safeMember(name))) wake(`inbox:${file}`);
      });
      watchers.push(w1);
    } catch (e) { mateFlow.infra("inbox watch 失败", { err: e.message }); }
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      const w2 = fs.watch(tasksDir, { persistent: false }, (event, file) => {
        if (file && TASK_FILE_RE.test(file)) wake(`task:${file}`);
      });
      watchers.push(w2);
    } catch (e) { mateFlow.infra("tasks watch 失败", { err: e.message }); }
    return () => {
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    };
  }

  // 上次给 LLM 提示"邮箱有新消息"时 inbox 文件的大小，用于避免重复刷屏
  let lastNotifiedInboxSize = 0;

  // 仅 peek 收件箱，不推进 cursor。
  //   - 返回 shouldShutdown：发现 shutdown_request 时为 true，主线程立即退出
  //   - 必要时给 messages 追加一条 <wake> 提示，告诉 LLM 收件箱有新消息
  //     → LLM 真正用 read_inbox 工具拉取，避免"系统自动消费 = 工具永远空"的歧义
  function probeInbox() {
    const { messages: msgs, size } = bus.peekInbox(name);
    const shouldShutdown = msgs.some((m) => m.type === "shutdown_request");

    // 已经就这个 size 提示过了，不再重复
    if (msgs.length > 0 && size > lastNotifiedInboxSize) {
      const last = messages[messages.length - 1];
      // 仅在 user/assistant 顺序允许时插入，避免破坏对话结构
      if (!last || last.role === "assistant") {
        const summary = msgs.map((m) => `${m.type}/${m.from}`).join(", ");
        messages.push({
          role: "user",
          content:
            `<wake>收件箱有 ${msgs.length} 条未读消息（${summary}）。` +
            `请用 read_inbox 工具读取并处理；如有 shutdown_request 请优先用 shutdown_response 响应。</wake>`,
        });
        lastNotifiedInboxSize = size;
      }
    }
    return shouldShutdown;
  }

  // === 主循环：工作 → 空闲（事件驱动）→ 工作 → ... ===
  let consecutiveEmptyPolls = 0;
  let lastActivityAt = Date.now();

  outer: while (true) {
    mateFlow.phase("进入工作阶段", { currentTaskId });

    // ======== 工作阶段 ========
    for (let i = 0; i < WORK_MAX_ITERATIONS; i++) {
      if (probeInbox()) {
        parentPort.postMessage({ type: "status", status: "shutdown" });
        return;
      }

      // 周期性身份重注入：保持 user → assistant → user → assistant 轮换合法
      if (toolRoundCounter > 0 && toolRoundCounter % IDENTITY_REMIND_EVERY === 0) {
        const last = messages[messages.length - 1];
        if (!last || last.role === "assistant") {
          messages.push(makeIdentityBlock(name, role, teamName));
          mateFlow.infra("身份重注入", { round: toolRoundCounter });
        }
      }

      mateFlow.llmRequest(messages.length, sysPrompt);
      let response;
      try {
        response = await callLlmWithRetry(client, {
          model, system: sysPrompt, messages,
          tools: TEAMMATE_TOOLS, max_tokens: 8000,
        }, mateFlow);
      } catch (e) {
        mateFlow.infra("LLM 最终失败", { err: e.message });
        parentPort.postMessage({ type: "status", status: "error", error: e.message });
        // 不直接退出，进入空闲等待；让 Lead 决定是否 shutdown
        break;
      }
      mateFlow.llmResponse(response);
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") break;

      const results = [];
      let idleRequested = false;
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let output;
        if (block.name === "idle") {
          idleRequested = true;
          output = "已进入空闲。系统会在新消息/新任务时自动唤醒。";
          mateFlow.infra("idle 工具", { name });
        } else {
          output = execTeammateTool(block.name, block.input);
        }
        mateFlow.toolUse(block, output, { actor: name });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: fmtResult(output),
        });
      }
      messages.push({ role: "user", content: results });
      toolRoundCounter += 1;
      lastActivityAt = Date.now();

      // 心跳：维持当前持有任务的活性
      if (currentTaskId) {
        const hb = heartbeatTask(tasksDir, currentTaskId, name);
        if (!hb.ok) {
          mateFlow.infra("心跳失败", { taskId: currentTaskId, err: hb.error });
          // 被回收了：让 LLM 知道，避免无谓继续干
          if (hb.error?.includes("持有者")) {
            messages.push({
              role: "user",
              content: `<system>任务 #${currentTaskId} 因长时间无心跳已被系统回收，请重新扫描任务板。</system>`,
            });
            currentTaskId = null;
          }
        }
      }

      if (idleRequested) break;
    }

    // ======== 空闲阶段（事件驱动 + 指数退避） ========
    mateFlow.phase("进入空闲", { consecutiveEmptyPolls });
    parentPort.postMessage({ type: "status", status: "idle" });

    let resume = false;
    let backoff = POLL_INTERVAL_MS * Math.min(8, Math.pow(2, consecutiveEmptyPolls));
    if (backoff > POLL_BACKOFF_MAX) backoff = POLL_BACKOFF_MAX;

    while (true) {
      // 软超时：长时间无事 → 退出
      if (Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
        mateFlow.phase("空闲软超时退出", { idleTimeoutMs: IDLE_TIMEOUT_MS });
        parentPort.postMessage({ type: "status", status: "shutdown" });
        return;
      }

      const abortController = new AbortController();
      const stopWatchers = setupWatchers(abortController);
      const reason = await sleepInterruptible(backoff, abortController.signal);
      stopWatchers();
      mateFlow.infra("空闲被唤醒", { reason, backoffMs: backoff });

      // 1) 先看 inbox（peek，不消费）
      if (probeInbox()) {
        parentPort.postMessage({ type: "status", status: "shutdown" });
        return;
      }
      const last = messages[messages.length - 1];
      const hasNewMsg = last && last.role === "user" && typeof last.content === "string" && last.content.startsWith("<wake>");
      if (hasNewMsg) {
        consecutiveEmptyPolls = 0;
        resume = true;
        break;
      }

      // 2) 再看任务板
      const unclaimed = scanTasks(tasksDir);
      if (unclaimed.length) {
        const task = unclaimed[0];
        mateFlow.infra("扫描到未认领任务", { id: task.id, subject: task.subject });
        const claimRes = claimTask(tasksDir, task.id, name);
        if (!claimRes.ok) {
          mateFlow.infra("自动认领失败", { id: task.id, error: claimRes.error });
          // 不阻塞，下一轮再扫
        } else {
          currentTaskId = claimRes.task.id;
          // 注入身份块再注入任务（确保 user/assistant 顺序合法）
          const prevRole = messages[messages.length - 1]?.role;
          if (prevRole === "assistant" || messages.length === 0) {
            messages.push(makeIdentityBlock(name, role, teamName));
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>任务 #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`,
          });
          consecutiveEmptyPolls = 0;
          resume = true;
          break;
        }
      }

      // 空轮询：增加退避（在下次循环用到）
      consecutiveEmptyPolls += 1;
      backoff = Math.min(POLL_BACKOFF_MAX, POLL_INTERVAL_MS * Math.pow(2, consecutiveEmptyPolls));
    }

    if (!resume) {
      parentPort.postMessage({ type: "status", status: "shutdown" });
      return;
    }
    parentPort.postMessage({ type: "status", status: "working" });
    lastActivityAt = Date.now();
    continue outer;
  }
}


// =====================================================================
// 程序入口
// =====================================================================
if (!isMainThread) {
  if (workerData?.isTeammate) {
    runTeammateLoop().catch((err) => console.error("队友循环异常：", err));
  }
} else {
  const SYSTEM =
    `你是工作在 ${WORKDIR} 的团队 Lead。你只需要派遣队员、发布任务，队员会自己领取任务。\n` +
    `如果看到 <wake>...</wake> 提示，请用 read_inbox 工具读取收件箱并响应。\n` +
    `如果看到 <system-notifications>...</system-notifications>，那是 Worker 状态/计划提交等系统事件，请结合上下文决策。`;

  const client = createLlmClient();
  const BUS    = new MessageBus(INBOX_DIR);
  const flow = createFlowContext("s11:lead");

  const shutdownRequests = {};
  const planRequests     = {};
  // 待 Lead 在下一轮 LLM 调用前注入的"系统通知"（worker exit / 状态变化 / 错误等）
  const pendingNotifications = [];

  // =====================================================================
  // 【生产化 TeammateManager】
  //
  // 主要修复：
  //   1. 监听 worker exit：正常退出 → status=shutdown；异常 → status=error；
  //      自动清理 this.workers[name] 引用，杜绝泄漏。
  //   2. _saveConfig 用 atomicWriteJson（tmp+rename），避免并发覆盖留下半文件。
  //   3. _setStatus 与 _saveConfig 走 promise queue 串行化，避免主线程内并发交错。
  //   4. spawn 前先校验已有 worker 是否真的存活；状态机更严格。
  //   5. requestShutdown 提供 timeout 兜底 → worker.terminate() 强杀。
  //   6. broadcast 自动过滤 shutdown/error 状态成员。
  //   7. 把 worker 状态变化作为 pendingNotifications 注入下一轮 LLM，让 Lead 看得见故障。
  // =====================================================================
  class TeammateManager {
    constructor(teamDir) {
      this.dir = teamDir;
      fs.mkdirSync(this.dir, { recursive: true });
      this.configPath = path.join(this.dir, "config.json");
      this.config = this._loadConfig();
      this.workers = {};       // name → Worker（只在 alive 时存在）
      this.lastErrors = {};    // name → 最近一次错误描述
      this._saveQueue = Promise.resolve();
    }

    _loadConfig() {
      if (fs.existsSync(this.configPath)) {
        const c = readJsonSafe(this.configPath);
        if (!c.__error && c.members) return c;
      }
      return { team_name: "default", members: [] };
    }

    // 串行化的原子保存：避免主线程内 race
    _saveConfig() {
      const snapshot = JSON.parse(JSON.stringify(this.config));
      this._saveQueue = this._saveQueue
        .catch(() => {})
        .then(() => atomicWriteJson(this.configPath, snapshot));
      return this._saveQueue;
    }

    _findMember(name) {
      return this.config.members.find((m) => m.name === name) || null;
    }

    _setStatus(name, status, extra = {}) {
      const member = this._findMember(name);
      if (!member) return;
      const prev = member.status;
      member.status = status;
      member.lastSeenAt = Date.now();
      if (extra.error) {
        member.lastError = extra.error;
        this.lastErrors[name] = extra.error;
      }
      this._saveConfig();
      if (prev !== status) {
        flowOnce("s11", "Worker 状态变化", { name, prev, status, ...extra });
        // 让 Lead 在下一轮看到故障/退出
        if (status === "error" || status === "shutdown") {
          pendingNotifications.push({
            kind: "teammate_status",
            name, status, prev,
            error: extra.error || null,
            exitCode: extra.exitCode ?? null,
            at: Date.now(),
          });
        }
      }
    }

    isAlive(name) {
      const w = this.workers[name];
      return !!w && w.threadId > 0;
    }

    spawn(name, role, prompt) {
      let nameSafe;
      try { nameSafe = safeMember(name); } catch (e) { return { ok: false, error: e.message }; }
      if (typeof role !== "string" || !role.trim()) {
        return { ok: false, error: "role 不能为空" };
      }

      const existingAlive = this.isAlive(nameSafe);
      let member = this._findMember(nameSafe);
      if (existingAlive) {
        return { ok: false, error: `'${nameSafe}' 已在运行中（状态 ${member?.status}）` };
      }
      if (member) {
        // 允许从 shutdown/error/idle 复活
        member.status = "spawning";
        member.role = role;
      } else {
        member = { name: nameSafe, role, status: "spawning", createdAt: Date.now() };
        this.config.members.push(member);
      }
      this._saveConfig();

      let worker;
      try {
        worker = new Worker(__filename, {
          workerData: {
            isTeammate: true,
            name: nameSafe,
            role,
            prompt,
            workdir:  WORKDIR,
            inboxDir: INBOX_DIR,
            tasksDir: TASKS_DIR,
            model:    MODEL,
            teamName: this.config.team_name,
            baseUrl:  process.env.OPENAI_BASE_URL || null,
            apiKey:   process.env.OPENAI_API_KEY  || null,
          },
        });
      } catch (e) {
        this._setStatus(nameSafe, "error", { error: `派生失败：${e.message}` });
        return { ok: false, error: `Worker 创建失败：${e.message}` };
      }

      this.workers[nameSafe] = worker;
      this._setStatus(nameSafe, "working");
      flowOnce("s11", "Worker 线程创建", { name: nameSafe, role, threadId: worker.threadId });

      worker.on("message", (msg) => {
        if (msg.type === "status") {
          this._setStatus(nameSafe, msg.status, msg.error ? { error: msg.error } : {});
        } else if (msg.type === "shutdown_response") {
          if (shutdownRequests[msg.reqId]) {
            shutdownRequests[msg.reqId].status = msg.approve ? "approved" : "rejected";
          }
        } else if (msg.type === "plan_submitted") {
          planRequests[msg.reqId] = { from: msg.from, plan: msg.plan, status: "pending" };
          pendingNotifications.push({
            kind: "plan_submitted",
            from: msg.from, reqId: msg.reqId,
            plan: String(msg.plan || "").slice(0, 500),
            at: Date.now(),
          });
        }
      });

      worker.on("error", (err) => {
        console.error(`队友 [${nameSafe}] 运行错误：`, err.message);
        this._setStatus(nameSafe, "error", { error: err.message });
      });

      // 关键修复：监听 exit，清理引用，更新状态
      worker.on("exit", (code) => {
        delete this.workers[nameSafe];
        const current = this._findMember(nameSafe)?.status;
        // 若没有显式 shutdown，按 exit code 推断
        if (current !== "shutdown" && current !== "error") {
          this._setStatus(nameSafe, code === 0 ? "shutdown" : "error", {
            exitCode: code,
            error: code === 0 ? null : `Worker 异常退出（code=${code}）`,
          });
        }
        flowOnce("s11", "Worker 退出", { name: nameSafe, code });
      });

      return { ok: true, message: `已派生 '${nameSafe}'（角色：${role}）`, threadId: worker.threadId };
    }

    listAll() {
      if (!this.config.members.length) return "暂无队员。";
      const lines = [`团队：${this.config.team_name}`];
      for (const m of this.config.members) {
        const alive = this.isAlive(m.name) ? "*" : " ";
        const err = m.lastError ? `（错误：${m.lastError}）` : "";
        lines.push(`  ${alive} ${m.name} (${m.role}): ${m.status}${err}`);
      }
      return lines.join("\n");
    }

    memberNames() {
      return this.config.members.map((m) => m.name);
    }

    statusOf(name) {
      return this._findMember(name)?.status || "unknown";
    }

    // 优雅停机：发 shutdown_request 消息，等 N 秒，超时强杀
    async requestShutdownWithFallback(name, { timeoutMs = SHUTDOWN_GRACE_MS } = {}) {
      let nameSafe;
      try { nameSafe = safeMember(name); } catch (e) { return { ok: false, error: e.message }; }
      const worker = this.workers[nameSafe];
      if (!worker) return { ok: false, error: `'${nameSafe}' 已离线` };
      const reqId = randomUUID().slice(0, 8);
      shutdownRequests[reqId] = { target: nameSafe, status: "pending" };
      BUS.send("lead", nameSafe, "请优雅关闭。", "shutdown_request", { request_id: reqId });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!this.isAlive(nameSafe)) return { ok: true, reqId, mode: "graceful" };
        await sleepInterruptible(200);
      }
      // 超时：强杀
      try {
        await worker.terminate();
        flowOnce("s11", "Worker 强制终止", { name: nameSafe, reqId });
        this._setStatus(nameSafe, "shutdown", { error: `优雅停机超时（${timeoutMs}ms），已 terminate` });
        return { ok: true, reqId, mode: "terminated" };
      } catch (e) {
        return { ok: false, error: `terminate 失败：${e.message}` };
      }
    }

    // 进程退出时调用：广播 shutdown，等所有 worker 收尾
    async shutdownAll({ timeoutMs = SHUTDOWN_GRACE_MS } = {}) {
      const names = Object.keys(this.workers);
      if (!names.length) return;
      flowOnce("s11", "主进程优雅停机：通知所有 Worker", { names });
      await Promise.all(names.map((n) => this.requestShutdownWithFallback(n, { timeoutMs })));
    }
  }

  const TEAM = new TeammateManager(TEAM_DIR);

  // === Lead 端工具实现 ===
  function handleShutdownRequest(teammate) {
    // 返回 Promise<对象>：触发优雅停机但不阻塞 LLM
    TEAM.requestShutdownWithFallback(teammate).then((r) => {
      pendingNotifications.push({
        kind: "shutdown_complete",
        target: teammate, result: r, at: Date.now(),
      });
    });
    return { ok: true, message: `已对 '${teammate}' 发起关闭（异步等待优雅或强制）` };
  }

  function handlePlanReview(requestId, approve, feedback = "") {
    const req = planRequests[requestId];
    if (!req) return { ok: false, error: `未知计划 request_id '${requestId}'` };
    req.status = approve ? "approved" : "rejected";
    BUS.send("lead", req.from, feedback, "plan_approval_response", {
      request_id: requestId, approve, feedback,
    });
    return { ok: true, message: `计划已${req.status === "approved" ? "批准" : "拒绝"}（来自 '${req.from}'）` };
  }

  function checkShutdownStatus(requestId) {
    return shutdownRequests[requestId]
      ? { ok: true, ...shutdownRequests[requestId] }
      : { ok: false, error: "未找到" };
  }

  // Lead 工具派发表
  const TOOL_HANDLERS = {
    bash:              (args) => runBash(args.command),
    read_file:         (args) => runRead(args.path, args.limit),
    write_file:        (args) => runWrite(args.path, args.content),
    edit_file:         (args) => runEdit(args.path, args.old_text, args.new_text),
    spawn_teammate:    (args) => TEAM.spawn(args.name, args.role, args.prompt),
    list_teammates:    ()     => TEAM.listAll(),
    send_message:      (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
    read_inbox:        ()     => JSON.stringify(BUS.readInbox("lead"), null, 2),
    broadcast:         (args) => BUS.broadcast("lead", args.content, TEAM.memberNames(), { statusOf: (n) => TEAM.statusOf(n) }),
    shutdown_request:  (args) => handleShutdownRequest(args.teammate),
    shutdown_response: (args) => checkShutdownStatus(args.request_id || ""),
    plan_approval:     (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
    task_create:       (args) => createTask(TASKS_DIR, args.subject, args.description || "", args.blockedBy || []),
    task_list:         ()     => listTasksSummary(TASKS_DIR),
    claim_task:        (args) => claimTask(TASKS_DIR, args.task_id, "lead"),
  };

  const TOOLS = [
    { name: "bash", description: "执行 shell 命令。",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "读取文件内容。",
      input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
    { name: "write_file", description: "将内容写入文件。",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file", description: "精确替换文件中的指定文本。",
      input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "spawn_teammate", description: "派生一个自主队员。",
      input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
    { name: "list_teammates", description: "列出所有队员及状态。",
      input_schema: { type: "object", properties: {} } },
    { name: "send_message", description: "向队员发送消息。",
      input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "读取 Lead 的收件箱（推进游标，不会丢消息）。",
      input_schema: { type: "object", properties: {} } },
    { name: "broadcast", description: "向所有在线队员广播消息（自动过滤离线/错误成员）。",
      input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
    { name: "shutdown_request", description: "优雅请求队员关闭（超时自动 terminate）。",
      input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
    { name: "shutdown_response", description: "查询关闭请求状态。",
      input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
    { name: "plan_approval", description: "批准或拒绝队员的计划。",
      input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
    { name: "task_create", description: "在任务板上创建新任务（队员可自动认领）。",
      input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" }, blockedBy: { type: "array", items: { type: "integer" } } }, required: ["subject"] } },
    { name: "task_list", description: "列出任务板上所有任务及其状态。",
      input_schema: { type: "object", properties: {} } },
    { name: "claim_task", description: "Lead 也可亲自认领（一般不需要）。",
      input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  ];

  let lastLeadInboxSize = 0;
  async function agentLoop(messages) {
    while (true) {
      // 注入 Worker 状态变化、plan 提交等"系统通知"
      if (pendingNotifications.length) {
        const batch = pendingNotifications.splice(0);
        flow.infra("注入系统通知", { count: batch.length });
        messages.push({
          role: "user",
          content: `<system-notifications>${JSON.stringify(batch, null, 2)}</system-notifications>`,
        });
      }

      // 只 peek 不消费——LLM 自己调 read_inbox 才会推进 cursor，
      // 这样工具调用永远能拿到真实消息（避免"邮箱永远是空的"歧义）
      const peek = BUS.peekInbox("lead");
      if (peek.messages.length && peek.size > lastLeadInboxSize) {
        flow.infra("Lead 收件箱提示", { count: peek.messages.length });
        const summary = peek.messages.map((m) => `${m.type}/${m.from}`).join(", ");
        messages.push({
          role: "user",
          content: `<wake>收件箱有 ${peek.messages.length} 条未读消息（${summary}）。请用 read_inbox 工具读取并处理。</wake>`,
        });
        lastLeadInboxSize = peek.size;
      }

      flow.llmRequest(messages.length, SYSTEM);
      let response;
      try {
        response = await callLlmWithRetry(client, {
          model: MODEL, system: SYSTEM, messages,
          tools: TOOLS, max_tokens: 8000,
        }, flow);
      } catch (e) {
        flow.infra("Lead LLM 最终失败", { err: e.message });
        messages.push({ role: "assistant", content: `LLM 调用失败：${e.message}（请稍后重试）` });
        return;
      }
      flow.llmResponse(response);
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") return;

      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const handler = TOOL_HANDLERS[block.name];
        let output;
        try {
          output = handler ? handler(block.input) : `未知工具：${block.name}`;
        } catch (e) {
          output = `错误：${e.message}`;
        }
        if (block.name.startsWith("task_") || block.name === "spawn_teammate" || block.name === "shutdown_request") {
          flow.infra(`Lead ${block.name}`, block.input);
        }
        flow.toolUse(block, output, { actor: "lead" });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: fmtResult(output),
        });
      }
      messages.push({ role: "user", content: results });
    }
  }

  // === 优雅停机：SIGINT / SIGTERM 触发，等所有 Worker 退出 ===
  let shuttingDown = false;
  async function gracefulExit(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在优雅停机...`);
    try {
      await TEAM.shutdownAll({ timeoutMs: SHUTDOWN_GRACE_MS });
    } catch (e) {
      console.error("停机异常：", e.message);
    } finally {
      process.exit(0);
    }
  }
  process.on("SIGINT", () => gracefulExit("SIGINT"));
  process.on("SIGTERM", () => gracefulExit("SIGTERM"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];

  const prompt = () => {
    rl.question("\x1b[36ms11 >> \x1b[0m", async (query) => {
      if (
        query === undefined ||
        ["q", "exit"].includes((query || "").trim().toLowerCase()) ||
        (query || "").trim() === ""
      ) {
        rl.close();
        await gracefulExit("user-quit");
        return;
      }

      // 调试命令
      const cmd = query.trim();
      if (cmd === "/team")  { console.log(`团队状态：\n${TEAM.listAll()}`); return prompt(); }
      if (cmd === "/inbox") { console.log(`主线程收件箱（peek，未消费）：\n${JSON.stringify(BUS.peekInbox("lead").messages, null, 2)}`); return prompt(); }
      if (cmd === "/tasks") { console.log(`任务板：\n${listTasksSummary(TASKS_DIR)}`); return prompt(); }

      history.push({ role: "user", content: query });
      flow.userTurn(query);
      try {
        await agentLoop(history);
      } catch (e) {
        console.error("Lead 主循环异常：", e.message);
      }
      const last = history[history.length - 1];
      if (Array.isArray(last?.content)) {
        for (const block of last.content) {
          if (block.type === "text") console.log(`LLM 回复：${block.text}`);
        }
      }
      console.log();
      prompt();
    });
  };

  prompt();
}
