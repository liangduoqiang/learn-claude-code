#!/usr/bin/env node
// s10_team_protocols.js - 团队协议（关闭协议 + 计划审批协议）
//
// 两种协议都使用相同的"请求 ID 关联"模式。
// 基于 s09 的团队消息系统构建。
//
//     关闭协议（有限状态机）：pending → approved | rejected
//
//     Lead                              队员
//     +---------------------+          +---------------------+
//     | shutdown_request     |          |                     |
//     | {                    | -------> | 收到请求            |
//     |   request_id: abc    |          | 决定：是否同意关闭？|
//     | }                    |          |                     |
//     +---------------------+          +---------------------+
//                                              |
//     +---------------------+          +-------v-------------+
//     | shutdown_response    | <------- | shutdown_response   |
//     | {                    |          | {                   |
//     |   request_id: abc    |          |   request_id: abc   |
//     |   approve: true      |          |   approve: true     |
//     | }                    |          | }                   |
//     +---------------------+          +---------------------+
//             |
//             v
//     状态 → "shutdown"，线程停止
//
//     计划审批协议（有限状态机）：pending → approved | rejected
//
//     队员                              Lead
//     +---------------------+          +---------------------+
//     | plan_approval        |          |                     |
//     | 提交: {plan:"..."}  | -------> | 审阅计划文本        |
//     +---------------------+          | 批准/拒绝？          |
//                                      +---------------------+
//                                              |
//     +---------------------+          +-------v-------------+
//     | plan_approval_resp   | <------- | plan_approval       |
//     | {approve: true}      |          | 审阅: {req_id,      |
//     +---------------------+          |   approve: true}     |
//                                      +---------------------+
//
//     追踪器：{request_id: {"target|from": name, "status": "pending|..."}}
//
// 【核心理念】相同的"请求 ID 关联"模式，应用于两个不同的业务场景。
//
// 【与 s09 的区别】
//   s09：队员单向接收任务，做完就停
//   s10：双向协议，队员可以主动提交计划，Lead 可以优雅关闭队员

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as process from "process";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const SYSTEM = `你是工作在 ${WORKDIR} 的团队 Lead。使用关闭和计划审批协议管理队员。`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// =====================================================================
// 请求追踪器：用 request_id 关联请求和响应
//
// 设计思路：
// - Lead 发起请求时生成唯一 request_id
// - 请求存入追踪器（memory 中）
// - 队员响应时带上 request_id
// - Lead 通过 request_id 找到原始请求并更新状态
// =====================================================================
const shutdownRequests = {};  // {request_id: {target, status}}
const planRequests = {};      // {request_id: {from, plan, status}}

// MessageBus（与 s09 相同）
class MessageBus {
  constructor(inboxDir) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(sender, to, content, msgType = "message", extra = {}) {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `错误：无效消息类型 '${msgType}'。有效类型：${[...VALID_MSG_TYPES].join(", ")}`;
    }
    const msg = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `已发送 ${msgType} 给 ${to}`;
  }

  readInbox(name) {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const text = fs.readFileSync(inboxPath, "utf8").trim();
    fs.writeFileSync(inboxPath, "");
    if (!text) return [];
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

const BUS = new MessageBus(INBOX_DIR);

// =====================================================================
// TeammateManager（增强版 s09）
//
// 新增：
// - _teammateLoop 作为 async 函数直接运行（不用 Worker 线程）
//   简化了代码结构，适用于不需要跨进程通信的场景
// - 队员支持 shutdown_response 和 plan_approval 协议工具
// =====================================================================
class TeammateManager {
  constructor(teamDir) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this._loadConfig();
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
    // 注意：这里直接用 async 函数而不是 Worker 线程
    // 优点：代码简单；缺点：在同一个 Node.js 事件循环中，可能阻塞主线程
    this._teammateLoop(name, role, prompt).catch(() => {});
    return `已派生 '${name}'（角色：${role}）`;
  }

  // 队员 Agent 循环（在主线程的事件循环中异步运行）
  async _teammateLoop(name, role, prompt) {
    const sysPrompt =
      `你是 '${name}'，角色：${role}，工作在 ${WORKDIR}。` +
      `在进行重要工作前，通过 plan_approval 提交计划。` +
      `收到 shutdown_request 时，用 shutdown_response 响应。`;
    const messages = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();
    let shouldExit = false;

    for (let i = 0; i < 50; i++) {
      // 检查收件箱
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      if (shouldExit) break;

      let response;
      try {
        response = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages,
          tools,
          max_tokens: 8000,
        });
      } catch {
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const results = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = this._exec(name, block.name, block.input);
          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
          // 如果批准了关闭请求，标记下一轮退出
          if (block.name === "shutdown_response" && block.input.approve) {
            shouldExit = true;
          }
        }
      }
      messages.push({ role: "user", content: results });
    }

    // 更新队员最终状态
    const member = this._findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      this._saveConfig();
    }
  }

  // 队员工具执行（包含协议处理）
  _exec(sender, toolName, args) {
    switch (toolName) {
      case "bash":
        return runBash(args.command);
      case "read_file":
        return runRead(args.path);
      case "write_file":
        return runWrite(args.path, args.content);
      case "edit_file":
        return runEdit(args.path, args.old_text, args.new_text);
      case "send_message":
        return BUS.send(sender, args.to, args.content, args.msg_type || "message");
      case "read_inbox":
        return JSON.stringify(BUS.readInbox(sender), null, 2);

      // 关闭协议响应：更新追踪器状态，回发确认消息
      case "shutdown_response": {
        const reqId = args.request_id;
        const approve = args.approve;
        if (reqId in shutdownRequests) {
          shutdownRequests[reqId].status = approve ? "approved" : "rejected";
        }
        BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
          request_id: reqId,
          approve,
        });
        return `关闭${approve ? "已批准" : "已拒绝"}`;
      }

      // 计划审批：生成 request_id，发送给 Lead 审阅
      case "plan_approval": {
        const planText = args.plan || "";
        const reqId = crypto.randomUUID().slice(0, 8);
        planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
        BUS.send(sender, "lead", planText, "plan_approval_response", {
          request_id: reqId,
          plan: planText,
        });
        return `计划已提交（request_id=${reqId}）。等待 Lead 审批。`;
      }

      default:
        return `未知工具：${toolName}`;
    }
  }

  // 队员可用工具集（包含协议工具）
  _teammateTools() {
    return [
      {
        name: "bash",
        description: "执行 shell 命令。",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "read_file",
        description: "读取文件内容。",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "将内容写入文件。",
        input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
      {
        name: "edit_file",
        description: "精确替换文件中的指定文本。",
        input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
      },
      {
        name: "send_message",
        description: "向队员发送消息。",
        input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] },
      },
      {
        name: "read_inbox",
        description: "读取并清空自己的收件箱。",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description: "响应关闭请求。批准则关闭，拒绝则继续工作。",
        input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] },
      },
      {
        name: "plan_approval",
        description: "向 Lead 提交计划请求审批。",
        input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
      },
    ];
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

// 基础工具实现
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) {
    return "错误：危险命令已被拦截";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = (output || "").trim();
    return trimmed ? trimmed.slice(0, 50000) : "(无输出)";
  } catch (err) {
    if (err.code === "ETIMEDOUT") return "错误：命令超时（120秒）";
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `错误：${err.message}`;
  }
}

function runRead(p, limit = null) {
  try {
    const lines = fs.readFileSync(safePath(p), "utf8").split("\n");
    const result =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runWrite(p, content) {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `已写入 ${content.length} 字节`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runEdit(p, oldText, newText) {
  try {
    const fp = safePath(p);
    const c = fs.readFileSync(fp, "utf8");
    if (!c.includes(oldText)) return `错误：在 ${p} 中未找到指定文本`;
    fs.writeFileSync(fp, c.replace(oldText, newText));
    return `已编辑 ${p}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

// =====================================================================
// Lead 专属协议处理函数
// =====================================================================

// 发起关闭请求（Lead → 队员）
function handleShutdownRequest(teammate) {
  const reqId = crypto.randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "请优雅关闭。", "shutdown_request", {
    request_id: reqId,
  });
  return `关闭请求 ${reqId} 已发送给 '${teammate}'（状态：pending）`;
}

// 审批队员的计划（Lead → 队员）
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

// 查询关闭请求状态
function checkShutdownStatus(requestId) {
  return JSON.stringify(shutdownRequests[requestId] || { error: "未找到" });
}

// Lead 工具派发表（12 个工具）
const TOOL_HANDLERS = {
  bash:             (kw) => runBash(kw.command),
  read_file:        (kw) => runRead(kw.path, kw.limit),
  write_file:       (kw) => runWrite(kw.path, kw.content),
  edit_file:        (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  spawn_teammate:   (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates:   ()   => TEAM.listAll(),
  send_message:     (kw) => BUS.send("lead", kw.to, kw.content, kw.msg_type || "message"),
  read_inbox:       ()   => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:        (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(kw.teammate),
  shutdown_response:(kw) => checkShutdownStatus(kw.request_id || ""),
  plan_approval:    (kw) => handlePlanReview(kw.request_id, kw.approve, kw.feedback || ""),
};

const TOOLS = [
  {
    name: "bash",
    description: "执行 shell 命令。",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "读取文件内容。",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "edit_file",
    description: "精确替换文件中的指定文本。",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
  },
  {
    name: "spawn_teammate",
    description: "派生一个持久化队员。",
    input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] },
  },
  {
    name: "list_teammates",
    description: "列出所有队员。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "向队员发送消息。",
    input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] },
  },
  {
    name: "read_inbox",
    description: "读取并清空 Lead 的收件箱。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "向所有队员广播消息。",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "请求队员优雅关闭。返回 request_id 用于追踪。",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "shutdown_response",
    description: "按 request_id 查询关闭请求的状态。",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
  },
  {
    name: "plan_approval",
    description: "批准或拒绝队员的计划。提供 request_id + approve + 可选反馈。",
    input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] },
  },
];

async function agentLoop(messages) {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
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

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history = [];

  const ask = () =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms10 >> \x1b[0m", resolve);
    });

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

    if (query.trim() === "/team") {
      console.log(TEAM.listAll());
      continue;
    }
    if (query.trim() === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      continue;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);

    const last = history[history.length - 1];
    if (Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    }
    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
