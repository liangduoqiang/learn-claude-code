#!/usr/bin/env node
// s09_agent_teams.js - Agent 团队（持久化协作）
//
// 持久化的命名 Agent（队员），每个队员有基于文件的 JSONL 收件箱。
// 每个队员在独立的 Worker 线程中运行自己的 Agent 循环。
// 通信通过"追加写入收件箱"实现。
//
//     子智能体（s04）：派发 → 执行 → 返回摘要 → 销毁
//     队员（s09）：   派发 → 工作 → 空闲 → 工作 → ... → 关闭
//                      （可以接收新消息并持续工作）
//
//     .team/config.json                   .team/inbox/
//     +----------------------------+      +------------------+
//     | {"team_name": "default",   |      | alice.jsonl      |
//     |  "members": [              |      | bob.jsonl        |
//     |    {"name":"alice",        |      | lead.jsonl       |
//     |     "role":"coder",        |      +------------------+
//     |     "status":"idle"}       |
//     |  ]}                        |      发消息给 alice:
//     +----------------------------+        fs.appendFileSync("alice.jsonl", msg)
//
//                                          读取 alice 的收件箱:
//     spawn_teammate("alice","coder",...)   msgs = lines.map(JSON.parse)
//          |                                fs.writeFileSync("alice.jsonl", "")
//          v                                return msgs  // 读后清空
//     Worker 线程: alice          Worker 线程: bob
//     +------------------+        +------------------+
//     | agent_loop       |        | agent_loop       |
//     | status: working  |        | status: idle     |
//     | ... 执行工具 ... |        | ... 等待消息 ... |
//     | status -> idle   |        |                  |
//     +------------------+        +------------------+
//
//     5 种消息类型：
//     +-------------------------+-----------------------------------+
//     | message                 | 普通文本消息                      |
//     | broadcast               | 广播给所有队员                    |
//     | shutdown_request        | 请求优雅关闭（s10 处理）          |
//     | shutdown_response       | 批准/拒绝关闭（s10 处理）         |
//     | plan_approval_response  | 批准/拒绝计划（s10 处理）         |
//     +-------------------------+-----------------------------------+
//
// 【核心理念】可以互相通信的队员。
//
// 【关键技术点】Worker 线程 vs 子进程 vs 子智能体：
//   - 子进程（s04 runSubagent）：完全隔离，结束后销毁，只返回摘要
//   - Worker 线程（本文件）：共享内存，持久存在，可以接收新消息
//   - Worker 线程更适合持久化协作，因为可以保持状态并持续工作

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as process from "process";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 获取当前文件路径（Worker 需要用文件路径来加载自身）
const __filename = fileURLToPath(import.meta.url);

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const MODEL = process.env.MODEL_ID;

// 合法的消息类型枚举（防止乱写类型）
const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);


// =====================================================================
// 【MessageBus】基于文件的消息总线
//
// 实现方式：每个队员有一个 JSONL 文件作为收件箱
//   - 发送：appendFileSync（追加一行 JSON）
//   - 接收：读取所有行并解析，然后清空文件
//
// 优势：
//   - 持久化（进程重启后消息不丢失）
//   - 无需网络
//   - 人工可读（可以直接查看文件内容）
//   - 多进程/线程安全（append 是原子操作）
// =====================================================================
class MessageBus {
  constructor(inboxDir) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // 向指定队员发送消息（追加写入 JSONL 文件）
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
    // 追加一行 JSON（每条消息一行）
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `已发送 ${msgType} 给 ${to}`;
  }

  // 读取并清空指定队员的收件箱
  readInbox(name) {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const text = fs.readFileSync(inboxPath, "utf8").trim();
    const messages = text
      ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    fs.writeFileSync(inboxPath, "");  // 读后清空（消费模式）
    return messages;
  }

  // 广播消息给所有队员（跳过发送者自己）
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
// 【TeammateManager】持久化队员管理器
//
// config.json 存储团队配置，workers 字典存储运行中的 Worker 线程引用。
//
// spawn 流程：
// 1. 更新/创建 config.json 中的成员记录
// 2. 创建 Worker 线程（传入配置数据）
// 3. Worker 线程执行 runTeammateLoop()
// 4. Worker 完成时发送 "done" 消息，主线程更新状态为 "idle"
// =====================================================================
class TeammateManager {
  constructor(teamDir) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this._loadConfig();
    this.workers = {};  // name → Worker 线程实例
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

  // 派生队员（创建 Worker 线程）
  spawn(name, role, prompt) {
    let member = this._findMember(name);
    if (member) {
      // 如果队员已存在，只允许在 idle 或 shutdown 状态下重新派生
      if (!["idle", "shutdown"].includes(member.status)) {
        return `错误：'${name}' 当前状态为 ${member.status}，无法重新派生`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this._saveConfig();

    // 创建 Worker 线程（使用当前文件，workerData 区分主线程和 Worker）
    const worker = new Worker(__filename, {
      workerData: {
        isTeammate: true,   // 标记：这是一个队员 Worker（而不是主线程）
        name,
        role,
        prompt,
        workdir: WORKDIR,
        inboxDir: INBOX_DIR,
        model: MODEL,
        baseUrl: process.env.ANTHROPIC_BASE_URL || null,
        apiKey: process.env.ANTHROPIC_API_KEY || null,
      },
    });
    this.workers[name] = worker;

    // 监听 Worker 的消息（当前只处理 "done" 消息）
    worker.on("message", (msg) => {
      if (msg.type === "done") {
        const m = this._findMember(name);
        if (m && m.status !== "shutdown") {
          m.status = "idle";  // Worker 完成工作 → 标记为空闲
          this._saveConfig();
        }
      }
    });
    worker.on("error", (err) => {
      console.error(`[${name}] Worker 错误：`, err.message);
    });

    return `已派生 '${name}'（角色：${role}）`;
  }

  // 列出所有队员状态
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


// 基础工具实现（主线程和 Worker 线程共用）
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
    if (!c.includes(oldText)) {
      return `错误：在 ${filePath} 中未找到指定文本`;
    }
    fs.writeFileSync(fp, c.replace(oldText, newText));
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}


// =====================================================================
// 【Worker 线程入口】队员 Agent 循环
//
// Worker 线程执行路径：
// 1. 读取 workerData 获取配置（name, role, prompt 等）
// 2. 创建自己的 Anthropic 客户端和 MessageBus
// 3. 进入 Agent 循环：
//    a. 读取收件箱（有消息则注入对话）
//    b. 调用 LLM
//    c. 执行工具（包括 send_message 和 read_inbox）
//    d. 如果不再调用工具，退出循环
// 4. 发送 "done" 消息给主线程
// =====================================================================
async function runTeammateLoop() {
  const { name, role, prompt, workdir, inboxDir, model, baseUrl, apiKey } = workerData;

  // Worker 线程创建自己的 Anthropic 客户端
  const clientOpts = {};
  if (baseUrl) clientOpts.baseURL = baseUrl;
  if (apiKey) clientOpts.apiKey = apiKey;
  const client = new Anthropic(clientOpts);

  const bus = new MessageBus(inboxDir);

  // 队员的系统提示：包含自己的身份和角色
  const sysPrompt =
    `你是 '${name}'，角色：${role}，工作在 ${workdir}。` +
    `使用 send_message 与其他队员通信。完成你的任务。`;

  // 从初始提示词开始对话
  const messages = [{ role: "user", content: prompt }];

  // 队员可用的工具（比主线程少：没有 spawn_teammate, list_teammates, broadcast）
  const TEAMMATE_TOOLS = [
    {
      name: "bash",
      description: "执行 shell 命令。",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "读取文件内容。",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "将内容写入文件。",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "精确替换文件中的指定文本。",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
    {
      name: "send_message",
      description: "向队员发送消息。",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "read_inbox",
      description: "读取并清空自己的收件箱。",
      input_schema: { type: "object", properties: {} },
    },
  ];

  // 队员工具执行函数
  function execTeammateTool(toolName, args) {
    if (toolName === "bash") return runBash(args.command, workdir);
    if (toolName === "read_file") return runRead(args.path, null, workdir);
    if (toolName === "write_file") return runWrite(args.path, args.content, workdir);
    if (toolName === "edit_file") return runEdit(args.path, args.old_text, args.new_text, workdir);
    if (toolName === "send_message")
      return bus.send(name, args.to, args.content, args.msg_type || "message");
    if (toolName === "read_inbox") return JSON.stringify(bus.readInbox(name), null, 2);
    return `未知工具：${toolName}`;
  }

  // 队员 Agent 循环（最多 50 轮防止死循环）
  for (let i = 0; i < 50; i++) {
    // 每轮开始时检查收件箱，有消息则注入对话
    const inbox = bus.readInbox(name);
    for (const msg of inbox) {
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
      break;  // API 调用失败时退出
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;  // LLM 不再调用工具，任务完成

    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const output = execTeammateTool(block.name, block.input);
        console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  // 工作完成，通知主线程
  parentPort.postMessage({ type: "done" });
}


// =====================================================================
// 程序入口：根据 isMainThread 决定运行主线程逻辑还是 Worker 逻辑
// 这是 Worker 线程的标准模式：一个文件，两种执行路径
// =====================================================================
if (!isMainThread) {
  // Worker 线程路径
  if (workerData?.isTeammate) {
    runTeammateLoop().catch(console.error);
  }
} else {
  // 主线程路径（Lead Agent）
  const SYSTEM = `你是工作在 ${WORKDIR} 的团队 Lead。派生队员并通过收件箱进行通信。`;

  const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
  const BUS = new MessageBus(INBOX_DIR);
  const TEAM = new TeammateManager(TEAM_DIR);

  // Lead Agent 工具派发表（9 个工具：基础 4 + 团队管理 5）
  const TOOL_HANDLERS = {
    bash:           (args) => runBash(args.command),
    read_file:      (args) => runRead(args.path, args.limit),
    write_file:     (args) => runWrite(args.path, args.content),
    edit_file:      (args) => runEdit(args.path, args.old_text, args.new_text),
    spawn_teammate: (args) => TEAM.spawn(args.name, args.role, args.prompt),
    list_teammates: ()     => TEAM.listAll(),
    send_message:   (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
    read_inbox:     ()     => JSON.stringify(BUS.readInbox("lead"), null, 2),
    broadcast:      (args) => BUS.broadcast("lead", args.content, TEAM.memberNames()),
  };

  const TOOLS = [
    {
      name: "bash",
      description: "执行 shell 命令。",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "读取文件内容。",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "将内容写入文件。",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "精确替换文件中的指定文本。",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
    {
      name: "spawn_teammate",
      description: "派生一个持久化队员，在独立的 Worker 线程中运行。",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["name", "role", "prompt"],
      },
    },
    {
      name: "list_teammates",
      description: "列出所有队员的名称、角色和状态。",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "send_message",
      description: "向队员的收件箱发送消息。",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "read_inbox",
      description: "读取并清空 Lead 的收件箱。",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "broadcast",
      description: "向所有队员广播消息。",
      input_schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  ];

  // Lead Agent 循环（每轮开始前检查收件箱）
  async function agentLoop(messages) {
    while (true) {
      // 读取 lead 的收件箱（来自队员的消息）
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
    rl.question("\x1b[36ms09 >> \x1b[0m", async (query) => {
      if (query === undefined || ["q", "exit"].includes(query.trim().toLowerCase()) || query.trim() === "") {
        rl.close();
        process.exit(0);
        return;
      }
      // 调试命令：直接查看团队状态和收件箱
      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
      } else if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      } else {
        history.push({ role: "user", content: query });
        await agentLoop(history);
        const last = history[history.length - 1];
        if (Array.isArray(last.content)) {
          for (const block of last.content) {
            if (block.type === "text") console.log(block.text);
          }
        }
        console.log();
      }
      prompt();
    });
  };

  prompt();
}
