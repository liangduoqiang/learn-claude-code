#!/usr/bin/env node
// s12_worktree_task_isolation.js - 工作树 + 任务隔离
//
// 用目录级别的隔离实现并行任务执行。
// 任务是"控制平面"，工作树是"执行平面"。
//
//     .tasks/task_12.json
//       {
//         "id": 12,
//         "subject": "实现认证重构",
//         "status": "in_progress",
//         "worktree": "auth-refactor"   ← 绑定到工作树
//       }
//
//     .worktrees/index.json
//       {
//         "worktrees": [
//           {
//             "name": "auth-refactor",
//             "path": ".../.worktrees/auth-refactor",
//             "branch": "wt/auth-refactor",
//             "task_id": 12,
//             "status": "active"
//           }
//         ]
//       }
//
// 【核心理念】用目录隔离，用任务 ID 协调。
//             每个工作树 = 独立的 git 分支 + 独立的文件系统目录
//             多个 Agent 可以在不同工作树中并行工作，互不干扰。
//
// 【什么是 git worktree？】
//   git worktree 允许在同一个 git 仓库中同时检出多个不同分支。
//   每个 worktree 是一个独立目录，有自己的工作文件，但共享 .git 历史。
//   类比：一个公司的多个工位，共用同一个档案室（git 历史），
//         但每个工位有自己的工作台（工作目录）。
//
// 【工作树生命周期】
//   create → active → [work] → keep（保留分支）或 remove（删除分支）
//   remove 时可选 complete_task=true 自动将关联任务标记为完成

import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as process from "process";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID;

// 自动检测 git 仓库根目录
function detectRepoRoot(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 10000,
    });
    if (r.status !== 0) return null;
    const root = r.stdout.trim();
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;

const SYSTEM =
  `你是工作在 ${WORKDIR} 的编程智能体。` +
  "使用任务和工作树工具进行多任务工作。" +
  "对于并行或有风险的变更：创建任务、分配工作树通道、" +
  "在那些通道中执行命令，然后选择保留或删除来结束。" +
  "需要生命周期可见性时使用 worktree_events。";

// =====================================================================
// 【EventBus】追加写入的生命周期事件总线
//
// 用途：可观测性（observability）
// 所有工作树和任务的生命周期事件都记录到 JSONL 文件。
// 开发者可以通过查看 events.jsonl 了解整个执行过程。
// =====================================================================
class EventBus {
  constructor(eventLogPath) {
    this.path = eventLogPath;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, "", "utf8");
    }
  }

  // 记录事件（追加写入，不修改历史）
  emit(event, task = {}, worktree = {}, error = null) {
    const payload = {
      event,           // 事件名：如 "worktree.create.after"
      ts: Date.now() / 1000,
      task: task || {},
      worktree: worktree || {},
    };
    if (error) payload.error = error;
    fs.appendFileSync(this.path, JSON.stringify(payload) + "\n", "utf8");
  }

  // 读取最近的 N 条事件
  listRecent(limit = 20) {
    const n = Math.max(1, Math.min(Math.floor(limit || 20), 200));
    const text = fs.readFileSync(this.path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    const recent = lines.slice(-n);
    const items = recent.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: "parse_error", raw: line };
      }
    });
    return JSON.stringify(items, null, 2);
  }
}

// =====================================================================
// 【TaskManager】带工作树绑定的持久化任务管理器
//
// 新增功能（相比 s07）：
// - worktree 字段：绑定到哪个工作树
// - bindWorktree / unbindWorktree：管理任务-工作树关联
// - created_at / updated_at：时间戳
// =====================================================================
class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  _maxId() {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
    return ids.length ? Math.max(...ids) : 0;
  }

  _filePath(taskId) {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  _load(taskId) {
    const fp = this._filePath(taskId);
    if (!fs.existsSync(fp)) throw new Error(`任务 ${taskId} 不存在`);
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  }

  _save(task) {
    fs.writeFileSync(this._filePath(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  create(subject, description = "") {
    const task = {
      id: this._nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",   // 工作树绑定（空=未绑定）
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this._save(task);
    this._nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId) {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  exists(taskId) {
    return fs.existsSync(this._filePath(taskId));
  }

  update(taskId, status = null, owner = null) {
    const task = this._load(taskId);
    if (status !== null && status !== undefined) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`无效状态：${status}`);
      }
      task.status = status;
    }
    if (owner !== null && owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  // 将任务与工作树绑定
  bindWorktree(taskId, worktree, owner = "") {
    const task = this._load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";  // 绑定时自动变为进行中
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  // 解除任务与工作树的绑定
  unbindWorktree(taskId) {
    const task = this._load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort();
    if (!files.length) return "暂无任务。";
    const tasks = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"))
    );
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return tasks
      .map((t) => {
        const marker = markers[t.status] || "[?]";
        const owner = t.owner ? ` owner=${t.owner}` : "";
        const wt = t.worktree ? ` wt=${t.worktree}` : "";
        return `${marker} #${t.id}: ${t.subject}${owner}${wt}`;
      })
      .join("\n");
  }
}

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));

// =====================================================================
// 【WorktreeManager】git 工作树管理器
//
// 核心操作：
// - create(name, taskId, baseRef)：
//     1. 运行 git worktree add（创建新分支 wt/<name>）
//     2. 记录到 .worktrees/index.json
//     3. 如果有 taskId，绑定任务
//     4. 发射生命周期事件
//
// - run(name, command)：
//     在指定工作树目录中执行命令（隔离执行）
//
// - remove(name, force, completeTask)：
//     1. 运行 git worktree remove
//     2. 如果 completeTask=true，自动完成关联任务
//     3. 更新 index.json 状态
//
// - keep(name)：
//     标记工作树为 "kept"（保留分支，不删除）
// =====================================================================
class WorktreeManager {
  constructor(repoRoot, tasks, events) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, "index.json");
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf8");
    }
    this.gitAvailable = this._isGitRepo();
  }

  // 检查当前目录是否是 git 仓库
  _isGitRepo() {
    try {
      const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.repoRoot,
        encoding: "utf8",
        timeout: 10000,
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  // 执行 git 命令（统一错误处理）
  _runGit(args) {
    if (!this.gitAvailable) {
      throw new Error("不在 git 仓库中。工作树工具需要 git。");
    }
    const r = spawnSync("git", args, {
      cwd: this.repoRoot,
      encoding: "utf8",
      timeout: 120000,
    });
    if (r.status !== 0) {
      const msg = ((r.stdout || "") + (r.stderr || "")).trim();
      throw new Error(msg || `git ${args.join(" ")} 失败`);
    }
    return ((r.stdout || "") + (r.stderr || "")).trim() || "(无输出)";
  }

  _loadIndex() {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
  }

  _saveIndex(data) {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf8");
  }

  _find(name) {
    const idx = this._loadIndex();
    return (idx.worktrees || []).find((wt) => wt.name === name) || null;
  }

  // 名称校验：只允许字母、数字、点、下划线、连字符
  _validateName(name) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("无效的工作树名称。使用 1-40 个字符：字母、数字、.、_、-");
    }
  }

  // 创建工作树
  create(name, taskId = null, baseRef = "HEAD") {
    this._validateName(name);
    if (this._find(name)) throw new Error(`工作树 '${name}' 已存在于索引中`);
    if (taskId !== null && !this.tasks.exists(taskId)) {
      throw new Error(`任务 ${taskId} 不存在`);
    }

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;  // 统一的分支命名规范

    // 发射"即将创建"事件
    this.events.emit(
      "worktree.create.before",
      taskId !== null ? { id: taskId } : {},
      { name, base_ref: baseRef }
    );

    try {
      // git worktree add -b wt/<name> <path> <base-ref>
      this._runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

      const entry = {
        name,
        path: wtPath,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      // 更新索引
      const idx = this._loadIndex();
      idx.worktrees.push(entry);
      this._saveIndex(idx);

      // 绑定任务（如果有）
      if (taskId !== null) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit(
        "worktree.create.after",
        taskId !== null ? { id: taskId } : {},
        { name, path: wtPath, branch, status: "active" }
      );
      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.emit(
        "worktree.create.failed",
        taskId !== null ? { id: taskId } : {},
        { name, base_ref: baseRef },
        String(e.message)
      );
      throw e;
    }
  }

  // 列出所有工作树
  listAll() {
    const idx = this._loadIndex();
    const wts = idx.worktrees || [];
    if (!wts.length) return "索引中暂无工作树。";
    return wts
      .map((wt) => {
        const suffix = wt.task_id != null ? ` task=${wt.task_id}` : "";
        return `[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`;
      })
      .join("\n");
  }

  // 查询单个工作树的 git 状态
  status(name) {
    const wt = this._find(name);
    if (!wt) return `错误：未知工作树 '${name}'`;
    if (!fs.existsSync(wt.path)) return `错误：工作树路径不存在：${wt.path}`;
    const r = spawnSync("git", ["status", "--short", "--branch"], {
      cwd: wt.path,
      encoding: "utf8",
      timeout: 60000,
    });
    const text = ((r.stdout || "") + (r.stderr || "")).trim();
    return text || "工作树干净（无未提交变更）";
  }

  // 在指定工作树中执行命令（核心隔离机制）
  run(name, command) {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      return "错误：危险命令已被拦截";
    }
    const wt = this._find(name);
    if (!wt) return `错误：未知工作树 '${name}'`;
    if (!fs.existsSync(wt.path)) return `错误：工作树路径不存在：${wt.path}`;
    try {
      const output = execSync(command, {
        cwd: wt.path,   // 关键：在工作树目录中执行
        timeout: 300000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const trimmed = output.trim();
      return trimmed ? trimmed.slice(0, 50000) : "(无输出)";
    } catch (err) {
      if (err.code === "ETIMEDOUT") return "错误：命令超时（300秒）";
      const out = ((err.stdout || "") + (err.stderr || "")).trim();
      return out ? out.slice(0, 50000) : `错误：${err.message}`;
    }
  }

  // 删除工作树（可选：同时完成关联任务）
  remove(name, force = false, completeTask = false) {
    const wt = this._find(name);
    if (!wt) return `错误：未知工作树 '${name}'`;

    this.events.emit(
      "worktree.remove.before",
      wt.task_id != null ? { id: wt.task_id } : {},
      { name, path: wt.path }
    );

    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");  // 强制删除（即使有未提交的变更）
      args.push(wt.path);
      this._runGit(args);

      // 如果指定完成关联任务
      if (completeTask && wt.task_id != null) {
        const taskId = wt.task_id;
        const before = JSON.parse(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit(
          "task.completed",
          { id: taskId, subject: before.subject || "", status: "completed" },
          { name }
        );
      }

      // 更新索引状态为 "removed"
      const idx = this._loadIndex();
      for (const item of idx.worktrees || []) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this._saveIndex(idx);

      this.events.emit(
        "worktree.remove.after",
        wt.task_id != null ? { id: wt.task_id } : {},
        { name, path: wt.path, status: "removed" }
      );
      return `已删除工作树 '${name}'`;
    } catch (e) {
      this.events.emit(
        "worktree.remove.failed",
        wt.task_id != null ? { id: wt.task_id } : {},
        { name, path: wt.path },
        String(e.message)
      );
      throw e;
    }
  }

  // 标记工作树为保留（不删除，但记录决定）
  keep(name) {
    const wt = this._find(name);
    if (!wt) return `错误：未知工作树 '${name}'`;

    const idx = this._loadIndex();
    let kept = null;
    for (const item of idx.worktrees || []) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this._saveIndex(idx);

    this.events.emit(
      "worktree.keep",
      wt.task_id != null ? { id: wt.task_id } : {},
      { name, path: wt.path, status: "kept" }
    );
    return kept ? JSON.stringify(kept, null, 2) : `错误：未知工作树 '${name}'`;
  }
}

const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// 基础工具实现
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`路径越界：${p}`);
  }
  return resolved;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "错误：危险命令已被拦截";
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    return trimmed ? trimmed.slice(0, 50000) : "(无输出)";
  } catch (err) {
    if (err.code === "ETIMEDOUT") return "错误：命令超时（120秒）";
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `错误：${err.message}`;
  }
}

function runRead(filePath, limit) {
  try {
    const resolved = safePath(filePath);
    const lines = fs.readFileSync(resolved, "utf8").split("\n");
    const truncated =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`]
        : lines;
    return truncated.join("\n").slice(0, 50000);
  } catch (err) {
    return `错误：${err.message}`;
  }
}

function runWrite(filePath, content) {
  try {
    const resolved = safePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return `已写入 ${content.length} 字节`;
  } catch (err) {
    return `错误：${err.message}`;
  }
}

function runEdit(filePath, oldText, newText) {
  try {
    const resolved = safePath(filePath);
    const content = fs.readFileSync(resolved, "utf8");
    if (!content.includes(oldText)) return `错误：在 ${filePath} 中未找到指定文本`;
    fs.writeFileSync(resolved, content.replace(oldText, newText), "utf8");
    return `已编辑 ${filePath}`;
  } catch (err) {
    return `错误：${err.message}`;
  }
}

// 工具派发表（基础 4 + 任务管理 5 + 工作树管理 7 = 16 个工具）
const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path: p, limit }) => runRead(p, limit),
  write_file: ({ path: p, content }) => runWrite(p, content),
  edit_file: ({ path: p, old_text, new_text }) => runEdit(p, old_text, new_text),
  task_create: ({ subject, description }) => TASKS.create(subject, description || ""),
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }) => TASKS.get(task_id),
  task_update: ({ task_id, status, owner }) => TASKS.update(task_id, status, owner),
  task_bind_worktree: ({ task_id, worktree, owner }) =>
    TASKS.bindWorktree(task_id, worktree, owner || ""),
  worktree_create: ({ name, task_id, base_ref }) =>
    WORKTREES.create(name, task_id ?? null, base_ref || "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: ({ name }) => WORKTREES.status(name),
  worktree_run: ({ name, command }) => WORKTREES.run(name, command),
  worktree_keep: ({ name }) => WORKTREES.keep(name),
  worktree_remove: ({ name, force, complete_task }) =>
    WORKTREES.remove(name, force || false, complete_task || false),
  worktree_events: ({ limit } = {}) => EVENTS.listRecent(limit || 20),
};

const TOOLS = [
  {
    name: "bash",
    description: "在当前工作区执行 shell 命令（阻塞）。",
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
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
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
    name: "task_create",
    description: "在共享任务板上创建新任务。",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_list",
    description: "列出所有任务（含状态、负责人和工作树绑定）。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "按 ID 获取任务详情。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "更新任务的状态或负责人。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        owner: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "将任务绑定到指定工作树名称。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        worktree: { type: "string" },
        owner: { type: "string" },
      },
      required: ["task_id", "worktree"],
    },
  },
  {
    name: "worktree_create",
    description: "创建 git 工作树，可选绑定到任务。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        task_id: { type: "integer" },
        base_ref: { type: "string" },  // 基准分支，默认 HEAD
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_list",
    description: "列出 .worktrees/index.json 中追踪的工作树。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "worktree_status",
    description: "显示指定工作树的 git 状态。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_run",
    description: "在指定工作树目录中执行 shell 命令（隔离执行）。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        command: { type: "string" },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_remove",
    description: "删除工作树，可选将关联任务标记为完成。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        force: { type: "boolean" },
        complete_task: { type: "boolean" },  // true 时自动完成关联任务
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "将工作树标记为保留（不删除，记录决策）。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_events",
    description: "列出 .worktrees/events.jsonl 中的近期生命周期事件。",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
];

async function agentLoop(messages) {
  while (true) {
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
        console.log(`\x1b[33m> ${block.name}:\x1b[0m`);
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
  console.log(`s12 仓库根目录：${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) {
    console.log("注意：不在 git 仓库中。worktree_* 工具将返回错误。");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history = [];

  const ask = () =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms12 >> \x1b[0m", resolve);
    });

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

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
