#!/usr/bin/env node
// s_full.js - Full Reference Agent (Node.js port)
//
// Capstone: all mechanisms combined -- the complete cockpit for the model.
//
//     +------------------------------------------------------------------+
//     |                        FULL AGENT                                 |
//     |                                                                   |
//     |  System prompt (s05 skills, task-first + optional todo nag)      |
//     |                                                                   |
//     |  Before each LLM call:                                            |
//     |  +--------------------+  +------------------+  +--------------+  |
//     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
//     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
//     |  +--------------------+  +------------------+  +--------------+  |
//     |                                                                   |
//     |  Tool dispatch (s02 pattern):                                     |
//     |  +--------+----------+----------+---------+-----------+          |
//     |  | bash   | read     | write    | edit    | TodoWrite |          |
//     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
//     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
//     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
//     |  | plan   | idle     | claim    |         |           |          |
//     |  +--------+----------+----------+---------+-----------+          |
//     |                                                                   |
//     |  Subagent (s04):  spawn -> work -> return summary                 |
//     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
//     |  Shutdown (s10):  request_id handshake                            |
//     |  Plan gate (s10): submit -> approve/reject                        |
//     +------------------------------------------------------------------+
//
//     REPL commands: /compact /tasks /team /inbox

import { createLlmClient, getModel } from "./llm_client.js";
import * as dotenv from "dotenv";
import { execSync, exec } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as readline from "readline";

dotenv.config({ override: true });
const WORKDIR = process.cwd();
const client = createLlmClient();
const MODEL = getModel();

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5000;
const IDLE_TIMEOUT = 60000;

const VALID_MSG_TYPES = [
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// === SECTION: base_tools ===
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    return trimmed ? trimmed.slice(0, 50000) : "(no output)";
  } catch (err) {
    if (err.code === "ETIMEDOUT") return "Error: Timeout (120s)";
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `Error: ${err.message}`;
  }
}

function runRead(filePath, limit = null) {
  try {
    const lines = fs.readFileSync(safePath(filePath), "utf8").split("\n");
    const result =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (${lines.length - limit} more)`]
        : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runWrite(filePath, content) {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runEdit(filePath, oldText, newText) {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}


// === SECTION: todos (s03) ===
class TodoManager {
  constructor() {
    this.items = [];
  }

  update(items) {
    const validated = [];
    let inProgressCount = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const activeForm = String(item.activeForm || "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status))
        throw new Error(`Item ${i}: invalid status '${status}'`);
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") inProgressCount++;
      validated.push({ content, status, activeForm });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgressCount > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }

  render() {
    if (!this.items.length) return "No todos.";
    const markers = { completed: "[x]", in_progress: "[>]", pending: "[ ]" };
    const lines = this.items.map((item) => {
      const m = markers[item.status] || "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${m} ${item.content}${suffix}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems() {
    return this.items.some((item) => item.status !== "completed");
  }
}


// === SECTION: subagent (s04) ===
async function runSubagent(prompt, agentType = "Explore") {
  const subTools = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];
  if (agentType !== "Explore") {
    subTools.push(
      {
        name: "write_file",
        description: "Write file.",
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
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      }
    );
  }
  const subHandlers = {
    bash: (kw) => runBash(kw.command),
    read_file: (kw) => runRead(kw.path),
    write_file: (kw) => runWrite(kw.path, kw.content),
    edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  };
  const subMsgs = [{ role: "user", content: prompt }];
  let resp = null;
  for (let i = 0; i < 30; i++) {
    resp = await client.messages.create({
      model: MODEL,
      messages: subMsgs,
      tools: subTools,
      max_tokens: 8000,
    });
    subMsgs.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") break;
    const results = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        const h = subHandlers[b.name] || (() => "Unknown tool");
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: String(h(b.input)).slice(0, 50000),
        });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }
  if (resp) {
    return (
      resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("") || "(no summary)"
    );
  }
  return "(subagent failed)";
}


// === SECTION: skills (s05) ===
class SkillLoader {
  constructor(skillsDir) {
    this.skills = {};
    if (fs.existsSync(skillsDir)) {
      for (const f of this._findSkillFiles(skillsDir).sort()) {
        const text = fs.readFileSync(f, "utf8");
        const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
        let meta = {},
          body = text;
        if (match) {
          for (const line of match[1].trim().split("\n")) {
            const colonIdx = line.indexOf(":");
            if (colonIdx !== -1) {
              meta[line.slice(0, colonIdx).trim()] = line
                .slice(colonIdx + 1)
                .trim();
            }
          }
          body = match[2].trim();
        }
        const name = meta.name || path.basename(path.dirname(f));
        this.skills[name] = { meta, body };
      }
    }
  }

  _findSkillFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...this._findSkillFiles(fullPath));
      else if (entry.name === "SKILL.md") results.push(fullPath);
    }
    return results;
  }

  descriptions() {
    if (!Object.keys(this.skills).length) return "(no skills)";
    return Object.entries(this.skills)
      .map(([n, s]) => `  - ${n}: ${s.meta.description || "-"}`)
      .join("\n");
  }

  load(name) {
    const s = this.skills[name];
    if (!s)
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}


// === SECTION: compression (s06) ===
function estimateTokens(messages) {
  return JSON.stringify(messages).length / 4;
}

function microcompact(messages) {
  const toolResults = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "tool_result") toolResults.push(part);
      }
    }
  }
  if (toolResults.length <= 3) return;
  for (const part of toolResults.slice(0, -3)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = "[cleared]";
    }
  }
}

async function autoCompact(messages) {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Date.now()}.jsonl`
  );
  fs.writeFileSync(
    transcriptPath,
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    "utf8"
  );
  const convText = JSON.stringify(messages).slice(-80000);
  const resp = await client.messages.create({
    model: MODEL,
    messages: [
      { role: "user", content: `Summarize for continuity:\n${convText}` },
    ],
    max_tokens: 2000,
  });
  const summary = resp.content[0].text;
  return [
    {
      role: "user",
      content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}`,
    },
  ];
}


// === SECTION: file_tasks (s07) ===
class TaskManager {
  constructor() {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  _nextId() {
    const files = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => f.match(/^task_\d+\.json$/));
    const ids = files.map((f) => parseInt(f.match(/task_(\d+)\.json/)[1]));
    return ids.length ? Math.max(...ids) + 1 : 1;
  }

  _load(tid) {
    const p = path.join(TASKS_DIR, `task_${tid}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  _save(task) {
    fs.writeFileSync(
      path.join(TASKS_DIR, `task_${task.id}.json`),
      JSON.stringify(task, null, 2)
    );
  }

  create(subject, description = "") {
    const task = {
      id: this._nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
    };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid) {
    return JSON.stringify(this._load(tid), null, 2);
  }

  update(tid, status = null, addBlockedBy = null, removeBlockedBy = null) {
    const task = this._load(tid);
    if (status) {
      task.status = status;
      if (status === "completed") {
        for (const f of fs
          .readdirSync(TASKS_DIR)
          .filter((f) => f.match(/^task_\d+\.json$/))) {
          const fp = path.join(TASKS_DIR, f);
          const t = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (t.blockedBy && t.blockedBy.includes(tid)) {
            t.blockedBy = t.blockedBy.filter((b) => b !== tid);
            fs.writeFileSync(fp, JSON.stringify(t, null, 2));
          }
        }
      }
      if (status === "deleted") {
        const p = path.join(TASKS_DIR, `task_${tid}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return `Task ${tid} deleted`;
      }
    }
    if (addBlockedBy)
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (removeBlockedBy)
      task.blockedBy = task.blockedBy.filter(
        (x) => !removeBlockedBy.includes(x)
      );
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    const files = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => f.match(/^task_\d+\.json$/))
      .sort();
    const tasks = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8"))
    );
    if (!tasks.length) return "No tasks.";
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return tasks
      .map((t) => {
        const m = markers[t.status] || "[?]";
        const owner = t.owner ? ` @${t.owner}` : "";
        const blocked =
          t.blockedBy && t.blockedBy.length
            ? ` (blocked by: ${JSON.stringify(t.blockedBy)})`
            : "";
        return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
      })
      .join("\n");
  }

  claim(tid, owner) {
    const task = this._load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this._save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}


// === SECTION: background (s08) ===
class BackgroundManager {
  constructor() {
    this.tasks = {};
    this.notifications = [];
  }

  run(command, timeout = 120) {
    const tid = crypto.randomUUID().slice(0, 8);
    this.tasks[tid] = { status: "running", command, result: null };
    exec(command, { cwd: WORKDIR, timeout: timeout * 1000 }, (err, stdout, stderr) => {
      const output = ((stdout || "") + (stderr || "")).trim().slice(0, 50000);
      if (err && err.killed) {
        this.tasks[tid] = { ...this.tasks[tid], status: "error", result: "Timeout" };
      } else {
        this.tasks[tid] = {
          ...this.tasks[tid],
          status: "completed",
          result: output || "(no output)",
        };
      }
      this.notifications.push({
        task_id: tid,
        status: this.tasks[tid].status,
        result: (this.tasks[tid].result || "").slice(0, 500),
      });
    });
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  check(tid = null) {
    if (tid) {
      const t = this.tasks[tid];
      return t
        ? `[${t.status}] ${t.result || "(running)"}`
        : `Unknown: ${tid}`;
    }
    const entries = Object.entries(this.tasks);
    return entries.length
      ? entries
          .map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`)
          .join("\n")
      : "No bg tasks.";
  }

  drain() {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }
}


// === SECTION: messaging (s09) ===
class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(sender, to, content, msgType = "message", extra = null) {
    const msg = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    fs.appendFileSync(
      path.join(INBOX_DIR, `${to}.jsonl`),
      JSON.stringify(msg) + "\n",
      "utf8"
    );
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name) {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const text = fs.readFileSync(inboxPath, "utf8").trim();
    const msgs = text
      ? text
          .split("\n")
          .filter((l) => l)
          .map((l) => JSON.parse(l))
      : [];
    fs.writeFileSync(inboxPath, "", "utf8");
    return msgs;
  }

  broadcast(sender, content, names) {
    let count = 0;
    for (const n of names) {
      if (n !== sender) {
        this.send(sender, n, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}


// === SECTION: shutdown + plan tracking (s10) ===
const shutdownRequests = {};
const planRequests = {};


// === SECTION: team (s09/s11) ===
class TeammateManager {
  constructor(bus, taskMgr) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.bus = bus;
    this.taskMgr = taskMgr;
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this._load();
  }

  _load() {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    }
    return { team_name: "default", members: [] };
  }

  _save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  _find(name) {
    return this.config.members.find((m) => m.name === name) || null;
  }

  spawn(name, role, prompt) {
    let member = this._find(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this._save();
    this._loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  _setStatus(name, status) {
    const member = this._find(name);
    if (member) {
      member.status = status;
      this._save();
    }
  }

  async _loop(name, role, prompt) {
    const teamName = this.config.team_name;
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle when done with current work. You may auto-claim tasks.`;
    const messages = [{ role: "user", content: prompt }];
    const tools = [
      {
        name: "bash",
        description: "Run command.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
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
        description: "Send message.",
        input_schema: {
          type: "object",
          properties: { to: { type: "string" }, content: { type: "string" } },
          required: ["to", "content"],
        },
      },
      {
        name: "idle",
        description: "Signal no more work.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim task by ID.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
      },
    ];

    while (true) {
      // -- WORK PHASE --
      let idleRequested = false;
      for (let i = 0; i < 50; i++) {
        const inbox = this.bus.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this._setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
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
          this._setStatus(name, "shutdown");
          return;
        }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;
        const results = [];
        idleRequested = false;
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output;
            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase.";
            } else if (block.name === "claim_task") {
              output = this.taskMgr.claim(block.input.task_id, name);
            } else if (block.name === "send_message") {
              output = this.bus.send(name, block.input.to, block.input.content);
            } else {
              const dispatch = {
                bash: (kw) => runBash(kw.command),
                read_file: (kw) => runRead(kw.path),
                write_file: (kw) => runWrite(kw.path, kw.content),
                edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
              };
              output = dispatch[block.name]
                ? dispatch[block.name](block.input)
                : "Unknown";
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
        if (idleRequested) break;
      }

      // -- IDLE PHASE: poll for messages and unclaimed tasks --
      this._setStatus(name, "idle");
      let resume = false;
      const idleRounds = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
      for (let i = 0; i < idleRounds; i++) {
        await sleep(POLL_INTERVAL);
        const inbox = this.bus.readInbox(name);
        if (inbox.length) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this._setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }
        if (fs.existsSync(TASKS_DIR)) {
          const unclaimed = fs
            .readdirSync(TASKS_DIR)
            .filter((f) => f.match(/^task_\d+\.json$/))
            .sort()
            .map((f) =>
              JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8"))
            )
            .filter(
              (t) =>
                t.status === "pending" &&
                !t.owner &&
                (!t.blockedBy || !t.blockedBy.length)
            );
          if (unclaimed.length) {
            const task = unclaimed[0];
            this.taskMgr.claim(task.id, name);
            if (messages.length <= 3) {
              messages.splice(
                0,
                0,
                {
                  role: "user",
                  content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
                },
                { role: "assistant", content: `I am ${name}. Continuing.` }
              );
            }
            messages.push({
              role: "user",
              content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`,
            });
            messages.push({
              role: "assistant",
              content: `Claimed task #${task.id}. Working on it.`,
            });
            resume = true;
            break;
          }
        }
      }
      if (!resume) {
        this._setStatus(name, "shutdown");
        return;
      }
      this._setStatus(name, "working");
    }
  }

  listAll() {
    if (!this.config.members.length) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames() {
    return this.config.members.map((m) => m.name);
  }
}


// === SECTION: global_instances ===
const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// === SECTION: system_prompt ===
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.\n` +
  `Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.\n` +
  `Use task for subagent delegation. Use load_skill for specialized knowledge.\n` +
  `Skills: ${SKILLS.descriptions()}`;


// === SECTION: shutdown_protocol (s10) ===
function handleShutdownRequest(teammate) {
  const reqId = crypto.randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", {
    request_id: reqId,
  });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// === SECTION: plan_approval (s10) ===
function handlePlanReview(requestId, approve, feedback = "") {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}


// === SECTION: tool_dispatch (s02) ===
const TOOL_HANDLERS = {
  bash: (kw) => runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  TodoWrite: (kw) => TODO.update(kw.items),
  task: async (kw) => runSubagent(kw.prompt, kw.agent_type || "Explore"),
  load_skill: (kw) => SKILLS.load(kw.name),
  compress: () => "Compressing...",
  background_run: (kw) => BG.run(kw.command, kw.timeout || 120),
  check_background: (kw) => BG.check(kw.task_id),
  task_create: (kw) => TASK_MGR.create(kw.subject, kw.description || ""),
  task_get: (kw) => TASK_MGR.get(kw.task_id),
  task_update: (kw) =>
    TASK_MGR.update(
      kw.task_id,
      kw.status,
      kw.add_blocked_by,
      kw.remove_blocked_by
    ),
  task_list: () => TASK_MGR.listAll(),
  spawn_teammate: (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (kw) =>
    BUS.send("lead", kw.to, kw.content, kw.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(kw.teammate),
  plan_approval: (kw) =>
    handlePlanReview(kw.request_id, kw.approve, kw.feedback || ""),
  idle: () => "Lead does not idle.",
  claim_task: (kw) => TASK_MGR.claim(kw.task_id, "lead"),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
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
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
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
    name: "TodoWrite",
    description: "Update task tracking list.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              activeForm: { type: "string" },
            },
            required: ["content", "status", "activeForm"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description: "Spawn a subagent for isolated exploration or work.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        agent_type: {
          type: "string",
          enum: ["Explore", "general-purpose"],
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "compress",
    description: "Manually compress conversation context.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "background_run",
    description: "Run command in background thread.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
      },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
    },
  },
  {
    name: "task_create",
    description: "Create a persistent file task.",
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
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "Update task status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        add_blocked_by: { type: "array", items: { type: "integer" } },
        remove_blocked_by: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent autonomous teammate.",
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
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: VALID_MSG_TYPES },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send message to all teammates.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "Enter idle state.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];


// === SECTION: agent_loop ===
async function agentLoop(messages) {
  let roundsWithoutTodo = 0;
  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
    // s08: drain background notifications
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${txt}\n</background-results>`,
      });
    }
    // s09: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
    }
    // LLM call
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    // Tool execution
    const results = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compress") manualCompress = true;
        const handler = TOOL_HANDLERS[block.name];
        let output;
        try {
          output = handler
            ? await Promise.resolve(handler(block.input))
            : `Unknown tool: ${block.name}`;
        } catch (e) {
          output = `Error: ${e.message}`;
        }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
        if (block.name === "TodoWrite") usedTodo = true;
      }
    }
    // s03: nag reminder (only when todo workflow is active)
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.push({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results });
    // s06: manual compress
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
      return;
    }
  }
}


// === SECTION: repl ===
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms_full >> \x1b[0m", resolve);
    });

  const history = [];

  while (true) {
    let query;
    try {
      query = await ask();
    } catch {
      break;
    }

    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

    if (query.trim() === "/compact") {
      if (history.length) {
        console.log("[manual compact via /compact]");
        const compacted = await autoCompact(history);
        history.length = 0;
        history.push(...compacted);
      }
      continue;
    }
    if (query.trim() === "/tasks") {
      console.log(TASK_MGR.listAll());
      continue;
    }
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
    const responseContent = last.content;
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
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
