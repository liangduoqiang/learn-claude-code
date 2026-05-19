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

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as process from "process";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const __filename = fileURLToPath(import.meta.url);

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const MODEL = process.env.MODEL_ID;

// 空闲轮询配置：每 5 秒检查一次，最多等 60 秒
const POLL_INTERVAL = 5000;   // 5 秒
const IDLE_TIMEOUT  = 60000;  // 60 秒

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);


// MessageBus（与 s09/s10 相同）
class MessageBus {
  constructor(inboxDir) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(sender, to, content, msgType = "message", extra = null) {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `错误：无效消息类型 '${msgType}'。有效类型：${[...VALID_MSG_TYPES].join(", ")}`;
    }
    const msg = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...(extra || {}),
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `已发送 ${msgType} 给 ${to}`;
  }

  readInbox(name) {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const text = fs.readFileSync(inboxPath, "utf8").trim();
    const messages = text
      ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender, content, teammates) {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `已广播给 ${count} 个队员`;
  }
}


// =====================================================================
// 任务板扫描函数（Worker 线程中使用）
//
// 扫描条件：status == "pending" AND owner == "" AND blockedBy 为空
// =====================================================================
function scanUnclaimedTasks(tasksDir) {
  fs.mkdirSync(tasksDir, { recursive: true });
  const files = fs
    .readdirSync(tasksDir)
    .filter((f) => /^task_\d+\.json$/.test(f))
    .sort();
  const unclaimed = [];
  for (const file of files) {
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8"));
    // 条件：待处理 + 无认领者 + 无阻塞依赖
    if (task.status === "pending" && !task.owner && !task.blockedBy) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

// 认领任务：设置 owner 和 status
function claimTask(taskId, owner, tasksDir) {
  const taskPath = path.join(tasksDir, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) return `错误：任务 ${taskId} 不存在`;
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  if (task.owner) {
    return `错误：任务 ${taskId} 已被 ${task.owner || "其他人"} 认领`;
  }
  if (task.status !== "pending") {
    return `错误：任务 ${taskId} 的状态为 '${task.status}'，无法认领`;
  }
  if (task.blockedBy) {
    return `错误：任务 ${taskId} 被其他任务阻塞，尚不可认领`;
  }
  task.owner = owner;
  task.status = "in_progress";
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  return `已为 ${owner} 认领任务 #${taskId}`;
}


// =====================================================================
// 身份重注入块
//
// 当 Agent 长时间运行或上下文被压缩后，可能"忘记"自己的身份。
// 在对话历史较短时（<= 3 条消息），注入身份块让 Agent 重新认识自己。
//
// 这类似于人在睡醒后需要"想起"自己是谁、在做什么。
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// =====================================================================
// 【Worker 线程入口】自主队员循环
//
// 两阶段循环：
//
// 【工作阶段】标准 Agent 循环（调用 LLM，执行工具）
//   → Agent 主动调用 idle 工具 → 进入空闲阶段
//   → LLM 自然停止调用工具 → 也进入空闲阶段
//
// 【空闲阶段】轮询等待（每 5 秒一次，最多 60 秒）
//   → 检查收件箱：有消息 → 恢复工作阶段
//   → 扫描任务板：有未认领任务 → 自动认领 → 恢复工作阶段
//   → 超时（60 秒无事可做）→ 发送 shutdown 状态 → 退出
// =====================================================================
async function runTeammateLoop() {
  const {
    name, role, prompt, workdir, inboxDir, tasksDir,
    model, baseUrl, apiKey, teamName,
  } = workerData;

  const clientOpts = {};
  if (baseUrl) clientOpts.baseURL = baseUrl;
  if (apiKey)  clientOpts.apiKey  = apiKey;
  const client = new Anthropic(clientOpts);

  const bus = new MessageBus(inboxDir);

  const sysPrompt =
    `你是 '${name}'，角色：${role}，团队：${teamName}，工作在 ${workdir}。` +
    `没有更多工作时使用 idle 工具。你会自动认领新任务。`;

  const messages = [{ role: "user", content: prompt }];

  // 队员工具集（比 s10 多了 idle 和 claim_task）
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
    { name: "read_inbox", description: "读取并清空自己的收件箱。",
      input_schema: { type: "object", properties: {} } },
    { name: "shutdown_response", description: "响应关闭请求。",
      input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
    { name: "plan_approval", description: "向 Lead 提交计划请求审批。",
      input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
    { name: "idle", description: "声明没有更多工作。进入空闲轮询阶段。",
      input_schema: { type: "object", properties: {} } },
    { name: "claim_task", description: "按 ID 从任务板认领任务。",
      input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  ];

  function execTeammateTool(toolName, args) {
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
      // 通知主线程关闭决定
      parentPort.postMessage({ type: "shutdown_response", reqId, approve: args.approve });
      bus.send(name, "lead", args.reason || "", "shutdown_response", {
        request_id: reqId,
        approve: args.approve,
      });
      return `关闭${args.approve ? "已批准" : "已拒绝"}`;
    }
    if (toolName === "plan_approval") {
      const reqId = randomUUID().slice(0, 8);
      const planText = args.plan || "";
      // 通知主线程有新计划提交
      parentPort.postMessage({ type: "plan_submitted", reqId, from: name, plan: planText });
      bus.send(name, "lead", planText, "plan_approval_response", {
        request_id: reqId,
        plan: planText,
      });
      return `计划已提交（request_id=${reqId}）。等待审批。`;
    }
    if (toolName === "claim_task") return claimTask(args.task_id, name, tasksDir);
    return `未知工具：${toolName}`;
  }

  // 外层循环：工作 → 空闲 → 工作 → ...
  while (true) {
    // ======== 工作阶段 ========
    for (let i = 0; i < 50; i++) {
      // 检查收件箱（优先处理消息）
      const inbox = bus.readInbox(name);
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          // 立即关闭（不等待 LLM 决定）
          parentPort.postMessage({ type: "status", status: "shutdown" });
          return;
        }
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      let response;
      try {
        response = await client.messages.create({
          model,
          system: sysPrompt,
          messages,
          tools: TEAMMATE_TOOLS,
          max_tokens: 8000,
        });
      } catch {
        parentPort.postMessage({ type: "status", status: "idle" });
        return;
      }

      messages.push({ role: "assistant", content: response.content });

      // LLM 不再调用工具 → 进入空闲阶段
      if (response.stop_reason !== "tool_use") break;

      const results = [];
      let idleRequested = false;
      for (const block of response.content) {
        if (block.type === "tool_use") {
          let output;
          if (block.name === "idle") {
            idleRequested = true;  // 标记 Agent 主动申请空闲
            output = "正在进入空闲阶段。将轮询新任务。";
          } else {
            output = execTeammateTool(block.name, block.input);
          }
          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
        }
      }
      messages.push({ role: "user", content: results });
      if (idleRequested) break;  // Agent 主动申请空闲 → 退出工作循环
    }

    // ======== 空闲阶段 ========
    // 通知主线程：当前状态为空闲
    parentPort.postMessage({ type: "status", status: "idle" });
    let resume = false;
    const polls = IDLE_TIMEOUT / POLL_INTERVAL;  // 最多轮询次数

    for (let i = 0; i < polls; i++) {
      await sleep(POLL_INTERVAL);  // 等待 5 秒

      // 优先检查收件箱
      const inbox = bus.readInbox(name);
      if (inbox.length > 0) {
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            parentPort.postMessage({ type: "status", status: "shutdown" });
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        resume = true;
        break;
      }

      // 扫描任务板，查找未认领任务
      const unclaimed = scanUnclaimedTasks(tasksDir);
      if (unclaimed.length > 0) {
        const task = unclaimed[0];
        const result = claimTask(task.id, name, tasksDir);
        if (result.startsWith("错误:")) continue;  // 认领失败（被抢了），继续轮询

        // 自动认领成功，准备工作提示词
        const taskPrompt =
          `<auto-claimed>任务 #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`;

        // 如果对话历史很短（可能是压缩后），注入身份信息防止"失忆"
        if (messages.length <= 3) {
          messages.unshift(
            { role: "assistant", content: `我是 ${name}。继续工作。` },
          );
          messages.unshift(makeIdentityBlock(name, role, teamName));
        }
        messages.push({ role: "user", content: taskPrompt });
        messages.push({ role: "assistant", content: `已认领任务 #${task.id}。正在处理。` });
        resume = true;
        break;
      }
    }

    if (!resume) {
      // 空闲超时，没有找到新工作 → 关闭
      parentPort.postMessage({ type: "status", status: "shutdown" });
      return;
    }
    // 恢复工作状态
    parentPort.postMessage({ type: "status", status: "working" });
  }
}


// =====================================================================
// 程序入口
// =====================================================================
if (!isMainThread) {
  if (workerData?.isTeammate) {
    runTeammateLoop().catch(console.error);
  }
} else {
  const SYSTEM =
    `你是工作在 ${WORKDIR} 的团队 Lead。队员是自主的——他们自己找工作。`;

  const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
  const BUS    = new MessageBus(INBOX_DIR);

  const shutdownRequests = {};
  const planRequests     = {};

  // TeammateManager（支持 Worker 线程状态同步）
  class TeammateManager {
    constructor(teamDir) {
      this.dir = teamDir;
      fs.mkdirSync(this.dir, { recursive: true });
      this.configPath = path.join(this.dir, "config.json");
      this.config = this._loadConfig();
      this.workers = {};
    }

    _loadConfig() {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      }
      return { team_name: "default", members: [] };
    }

    _saveConfig() {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    }

    _findMember(name) {
      return this.config.members.find((m) => m.name === name) || null;
    }

    _setStatus(name, status) {
      const member = this._findMember(name);
      if (member) {
        member.status = status;
        this._saveConfig();
      }
    }

    spawn(name, role, prompt) {
      let member = this._findMember(name);
      if (member) {
        if (!["idle", "shutdown"].includes(member.status)) {
          return `错误：'${name}' 当前状态为 ${member.status}`;
        }
        member.status = "working";
        member.role = role;
      } else {
        member = { name, role, status: "working" };
        this.config.members.push(member);
      }
      this._saveConfig();

      const worker = new Worker(__filename, {
        workerData: {
          isTeammate: true,
          name,
          role,
          prompt,
          workdir:  WORKDIR,
          inboxDir: INBOX_DIR,
          tasksDir: TASKS_DIR,
          model:    MODEL,
          teamName: this.config.team_name,
          baseUrl:  process.env.ANTHROPIC_BASE_URL || null,
          apiKey:   process.env.ANTHROPIC_API_KEY  || null,
        },
      });
      this.workers[name] = worker;

      // 处理 Worker 发来的状态通知
      worker.on("message", (msg) => {
        if (msg.type === "status") {
          this._setStatus(name, msg.status);
        } else if (msg.type === "shutdown_response") {
          if (shutdownRequests[msg.reqId]) {
            shutdownRequests[msg.reqId].status = msg.approve ? "approved" : "rejected";
          }
        } else if (msg.type === "plan_submitted") {
          planRequests[msg.reqId] = { from: msg.from, plan: msg.plan, status: "pending" };
        }
      });
      worker.on("error", (err) => {
        console.error(`[${name}] Worker 错误：`, err.message);
      });

      return `已派生 '${name}'（角色：${role}）`;
    }

    listAll() {
      if (!this.config.members.length) return "暂无队员。";
      const lines = [`团队：${this.config.team_name}`];
      for (const m of this.config.members) {
        lines.push(`  ${m.name} (${m.role}): ${m.status}`);
      }
      return lines.join("\n");
    }

    memberNames() {
      return this.config.members.map((m) => m.name);
    }
  }

  const TEAM = new TeammateManager(TEAM_DIR);

  function handleShutdownRequest(teammate) {
    const reqId = randomUUID().slice(0, 8);
    shutdownRequests[reqId] = { target: teammate, status: "pending" };
    BUS.send("lead", teammate, "请优雅关闭。", "shutdown_request", {
      request_id: reqId,
    });
    return `关闭请求 ${reqId} 已发送给 '${teammate}'`;
  }

  function handlePlanReview(requestId, approve, feedback = "") {
    const req = planRequests[requestId];
    if (!req) return `错误：未知计划 request_id '${requestId}'`;
    req.status = approve ? "approved" : "rejected";
    BUS.send("lead", req.from, feedback, "plan_approval_response", {
      request_id: requestId,
      approve,
      feedback,
    });
    return `计划已${req.status === "approved" ? "批准" : "拒绝"}（来自 '${req.from}'）`;
  }

  function checkShutdownStatus(requestId) {
    return JSON.stringify(shutdownRequests[requestId] || { error: "未找到" });
  }

  // Lead 工具派发表（14 个工具：比 s10 多了 idle 和 claim_task）
  const TOOL_HANDLERS = {
    bash:              (args) => runBash(args.command),
    read_file:         (args) => runRead(args.path, args.limit),
    write_file:        (args) => runWrite(args.path, args.content),
    edit_file:         (args) => runEdit(args.path, args.old_text, args.new_text),
    spawn_teammate:    (args) => TEAM.spawn(args.name, args.role, args.prompt),
    list_teammates:    ()     => TEAM.listAll(),
    send_message:      (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
    read_inbox:        ()     => JSON.stringify(BUS.readInbox("lead"), null, 2),
    broadcast:         (args) => BUS.broadcast("lead", args.content, TEAM.memberNames()),
    shutdown_request:  (args) => handleShutdownRequest(args.teammate),
    shutdown_response: (args) => checkShutdownStatus(args.request_id || ""),
    plan_approval:     (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
    idle:              ()     => "Lead 不进入空闲状态。",
    claim_task:        (args) => claimTask(args.task_id, "lead", TASKS_DIR),
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
    { name: "list_teammates", description: "列出所有队员。",
      input_schema: { type: "object", properties: {} } },
    { name: "send_message", description: "向队员发送消息。",
      input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "读取并清空 Lead 的收件箱。",
      input_schema: { type: "object", properties: {} } },
    { name: "broadcast", description: "向所有队员广播消息。",
      input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
    { name: "shutdown_request", description: "请求队员关闭。",
      input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
    { name: "shutdown_response", description: "查询关闭请求状态。",
      input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
    { name: "plan_approval", description: "批准或拒绝队员的计划。",
      input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
    { name: "idle", description: "进入空闲状态（Lead 一般不使用）。",
      input_schema: { type: "object", properties: {} } },
    { name: "claim_task", description: "按 ID 认领任务板上的任务。",
      input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  ];

  async function agentLoop(messages) {
    while (true) {
      const inbox = BUS.readInbox("lead");
      if (inbox.length) {
        messages.push({
          role: "user",
          content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
        });
      }

      const response = await client.messages.create({
        model: MODEL,
        system: SYSTEM,
        messages,
        tools: TOOLS,
        max_tokens: 8000,
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") return;

      const results = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const handler = TOOL_HANDLERS[block.name];
          let output;
          try {
            output = handler ? handler(block.input) : `未知工具：${block.name}`;
          } catch (e) {
            output = `错误：${e.message}`;
          }
          console.log(`> ${block.name}:`);
          console.log(String(output).slice(0, 200));
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
        }
      }
      messages.push({ role: "user", content: results });
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];

  const prompt = () => {
    rl.question("\x1b[36ms11 >> \x1b[0m", async (query) => {
      if (
        query === undefined ||
        ["q", "exit"].includes(query.trim().toLowerCase()) ||
        query.trim() === ""
      ) {
        rl.close();
        process.exit(0);
        return;
      }

      // 调试命令
      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        return prompt();
      }
      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        return prompt();
      }
      if (query.trim() === "/tasks") {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        const files = fs
          .readdirSync(TASKS_DIR)
          .filter((f) => /^task_\d+\.json$/.test(f))
          .sort();
        for (const file of files) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf8"));
          const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
          const owner = t.owner ? ` @${t.owner}` : "";
          console.log(`  ${marker} #${t.id}: ${t.subject}${owner}`);
        }
        return prompt();
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);
      const last = history[history.length - 1];
      if (Array.isArray(last.content)) {
        for (const block of last.content) {
          if (block.type === "text") console.log(block.text);
        }
      }
      console.log();
      prompt();
    });
  };

  prompt();
}
