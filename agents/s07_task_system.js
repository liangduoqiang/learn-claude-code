#!/usr/bin/env node
// s07_task_system.js - 持久化任务系统
//
// 任务以 JSON 文件形式持久化存储在 .tasks/ 目录，
// 因此可以跨越上下文压缩存活（存在文件系统而不是内存中）。
// 每个任务有依赖图（blockedBy 字段）。
//
//     .tasks/
//       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
//       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
//       task_3.json  {"id":3, "blockedBy":[2], ...}
//
//     依赖解析：
//     +----------+     +----------+     +----------+
//     | 任务 1   | --> | 任务 2   | --> | 任务 3   |
//     | 已完成   |     | 被阻塞   |     | 被阻塞   |
//     +----------+     +----------+     +----------+
//          |                ^
//          +--- 任务 1 完成时，自动从任务 2 的 blockedBy 中移除
//
// 【核心理念】状态存储在对话之外 —— 因为它存在文件系统上。
//             即使上下文被压缩清空，任务状态依然存在。
//             这解决了 LLM 上下文压缩时丢失任务状态的问题。

import { createLlmClient, getModel } from "./llm_client.js";
import { createFlowContext } from "./exec_flow.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const client = createLlmClient();
const MODEL = getModel();
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const flow = createFlowContext("s07");

const SYSTEM = `你是一个工作在 ${WORKDIR} 目录的编程智能体。使用任务工具规划和追踪工作。`;


// =====================================================================
// 【TaskManager】基于文件的持久化任务管理器
//
// 核心特性：
// - 每个任务 = 一个 JSON 文件（task_N.json）
// - 依赖图：blockedBy 数组（被哪些任务 ID 阻塞）
// - 依赖自动解除：任务完成时扫描所有任务，从 blockedBy 中移除该 ID
// - 持久化：任务数据在进程重启、上下文压缩后仍然存在
// =====================================================================
class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  // 找到当前最大任务 ID（用于生成下一个 ID）
  _maxId() {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    if (files.length === 0) return 0;
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
    return Math.max(...ids);
  }

  // 加载指定任务文件
  _load(taskId) {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`任务 ${taskId} 不存在`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  // 保存任务到文件（格式化 JSON 方便人工查看）
  _save(task) {
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8");
  }

  // 创建新任务
  create(subject, description = "") {
    const task = {
      id: this._nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],     // 依赖的任务 ID 列表（空=无依赖，可立即执行）
      owner: "",         // 认领该任务的 Agent 名称
    };
    this._save(task);
    this._nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId) {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  // 更新任务状态和依赖关系
  update(taskId, status = null, addBlockedBy = null, removeBlockedBy = null) {
    const task = this._load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`无效状态：${status}`);
      }
      task.status = status;
      // 任务完成时自动解除其他任务对它的依赖
      if (status === "completed") {
        this._clearDependency(taskId);
      }
    }
    if (addBlockedBy) {
      // 去重合并依赖列表
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (removeBlockedBy) {
      task.blockedBy = task.blockedBy.filter((x) => !removeBlockedBy.includes(x));
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  // 当某个任务完成时，扫描所有任务，从 blockedBy 中移除该任务 ID
  // 这实现了依赖的自动解除：A 完成 → B 不再被 A 阻塞
  _clearDependency(completedId) {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    for (const f of files) {
      const task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
      if (task.blockedBy && task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this._save(task);
      }
    }
  }

  // 列出所有任务（按 ID 排序）
  listAll() {
    const files = fs.readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort((a, b) => {
        const idA = parseInt(a.replace("task_", "").replace(".json", ""), 10);
        const idB = parseInt(b.replace("task_", "").replace(".json", ""), 10);
        return idA - idB;
      });

    if (files.length === 0) return "暂无任务。";

    const lines = files.map((f) => {
      const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
      const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
      const marker = markers[t.status] || "[?]";
      const blocked = t.blockedBy && t.blockedBy.length > 0
        ? ` (被阻塞：${JSON.stringify(t.blockedBy)})`
        : "";
      return `${marker} #${t.id}: ${t.subject}${blocked}`;
    });
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);


// 路径安全检查
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

// 基础工具实现
function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
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
    return output.trim().slice(0, 50000) || "(无输出)";
  } catch (e) {
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    if (e.signal === "SIGTERM") return "错误：命令超时（120秒）";
    return out.slice(0, 50000) || `错误：${e.message}`;
  }
}

function runRead(filePath, limit = null) {
  try {
    const lines = fs.readFileSync(safePath(filePath), "utf8").split("\n");
    const result = limit && limit < lines.length
      ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
      : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runWrite(filePath, content) {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `已写入 ${content.length} 字节`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

function runEdit(filePath, oldText, newText) {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `错误：在 ${filePath} 中未找到指定文本`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}


// 工具派发表（增加了 4 个任务管理工具）
const TOOL_HANDLERS = {
  bash:        ({ command }) => runBash(command),
  read_file:   ({ path: p, limit }) => runRead(p, limit),
  write_file:  ({ path: p, content }) => runWrite(p, content),
  edit_file:   ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
  task_create: ({ subject, description }) => TASKS.create(subject, description || ""),
  task_update: ({ task_id, status, addBlockedBy, removeBlockedBy }) =>
    TASKS.update(task_id, status, addBlockedBy, removeBlockedBy),
  task_list:   () => TASKS.listAll(),
  task_get:    ({ task_id }) => TASKS.get(task_id),
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
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "task_create",
    description: "创建新任务（持久化到文件）。",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_update",
    description: "更新任务的状态或依赖关系。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        addBlockedBy: { type: "array", items: { type: "integer" } },     // 新增依赖
        removeBlockedBy: { type: "array", items: { type: "integer" } },  // 移除依赖
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "列出所有任务及其状态摘要。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "按 ID 获取任务的完整详情。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];


async function agentLoop(messages) {
  while (true) {
    flow.llmRequest(messages.length, SYSTEM);
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    flow.llmResponse(response);

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
        if (block.name.startsWith("task_")) {
          flow.infra("任务系统", { tool: block.name, input: block.input });
        }
        flow.toolUse(block, output);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}


// 命令行交互（使用回调风格，与 s01-s06 的 async/await 风格不同）
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history = [];

function prompt() {
  rl.question("\x1b[36ms07 >> \x1b[0m", async (query) => {
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
      rl.close();
      return;
    }
    history.push({ role: "user", content: query });
    flow.userTurn(query);
    await agentLoop(history);
    const last = history[history.length - 1].content;
    if (Array.isArray(last)) {
      for (const block of last) {
        if (block.text) console.log(`LLM 回复：${block.text}`);
      }
    }
    console.log();
    prompt();  // 递归调用以保持交互
  });
}

rl.on("close", () => process.exit(0));
prompt();
