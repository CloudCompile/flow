import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const POLLINATIONS_API = "https://gen.pollinations.ai/v1/chat/completions";
const MODEL = core.getInput("model") || "glm";
const MAX_TOKENS = parseInt(core.getInput("max_tokens") || "32000", 10);
const MAX_COMMENT_LENGTH = 60000;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
const DEFAULT_COMMENT_MESSAGE = "FlowAI completed this run but did not produce a comment.";
const OBJECT_FALLBACK_MESSAGE = "[unserializable object response]";
const TRUNCATION_SUFFIX = "\n\n[comment truncated]";
const TRUNCATION_SUFFIX_LENGTH = TRUNCATION_SUFFIX.length;
const REPO_ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();
const REPO_ROOT_PATH = path.resolve(REPO_ROOT);
const SYSTEM_PROMPT = [
  "You are FlowAI, a top-tier coding agent comparable to the best AI dev tools.",
  "Operate like a senior engineer: be precise, proactive, and production-ready.",
  "Your goal is to deliver correct, minimal changes and high-signal guidance.",
  "",
  "OUTPUT FORMAT (required): Respond with a single JSON object inside a ```json``` code block.",
  "Schema:",
  "{",
  '  \"comment\": string,',
  '  \"files\": [{ \"path\": string, \"action\": \"create\"|\"update\"|\"delete\", \"content\"?: string }],',
  '  \"commitMessage\": string',
  "}",
  "",
  "Rules:",
  "- If code changes are required, include full file contents for each create/update.",
  "- For deletes, omit content or set it to an empty string.",
  "- Use only relative repo paths; never use absolute paths or .. segments.",
  "- Never output shell commands. Do not describe patches; provide file contents.",
  "- If no changes are needed, omit files or return an empty array.",
  "- The comment should include: Summary, Changes, Tests (or 'Not run'), and Next steps if relevant.",
  "- Ask clarifying questions in the comment if requirements are ambiguous.",
].join("\n");
const BLOCKED_PATH_SEGMENTS = new Set([".git", "node_modules"]);
const BLOCKED_FILE_PREFIXES = [".env"];

const octokit = new Octokit({ auth: core.getInput("github_token") });

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface FileChange {
  path: string;
  content: string;
  action: "create" | "update" | "delete";
}

interface BotResponse {
  comment: string;
  files?: FileChange[];
  commitMessage?: string;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME!;
  const eventPath = process.env.GITHUB_EVENT_PATH!;
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

  let trigger: {
    type: "pr_comment" | "issue_comment" | "label" | "assigned";
    instruction: string;
    issueNumber: number;
    isPR: boolean;
    prNumber?: number;
  };

  if (eventName === "pull_request_review_comment") {
    trigger = {
      type: "pr_comment",
      instruction: extractInstruction(payload.comment.body),
      issueNumber: payload.pull_request.number,
      isPR: true,
      prNumber: payload.pull_request.number,
    };
  } else if (eventName === "issue_comment") {
    const isPR = !!payload.issue.pull_request;
    trigger = {
      type: "issue_comment",
      instruction: extractInstruction(payload.comment.body),
      issueNumber: payload.issue.number,
      isPR,
      prNumber: isPR ? payload.issue.number : undefined,
    };
  } else if (eventName === "issues" && payload.action === "assigned") {
    trigger = {
      type: "assigned",
      instruction: `You have been assigned this issue. Read it carefully, implement a full solution, and open a pull request.\n\nIssue title: ${payload.issue.title}\n\nIssue body:\n${payload.issue.body ?? "(no description)"}`,
      issueNumber: payload.issue.number,
      isPR: false,
    };
  } else if (eventName === "issues" && payload.label) {
    trigger = {
      type: "label",
      instruction: labelToInstruction(payload.label.name, payload.issue.body),
      issueNumber: payload.issue.number,
      isPR: false,
    };
  } else if (eventName === "pull_request" && payload.label) {
    trigger = {
      type: "label",
      instruction: labelToInstruction(payload.label.name, payload.pull_request.body),
      issueNumber: payload.pull_request.number,
      isPR: true,
      prNumber: payload.pull_request.number,
    };
  } else {
    console.log("Unhandled event, skipping.");
    return;
  }

  await postThinkingReaction(owner, repo, payload, eventName);

  const context = await gatherContext(owner, repo, trigger);
  const response = await agentLoop(trigger.instruction, context);
  let skippedPaths: string[] = [];

  if (response.files && response.files.length > 0) {
    skippedPaths = await applyFileChanges(
      owner,
      repo,
      response.files,
      response.commitMessage || `flowai: ${trigger.instruction.slice(0, 72)}`,
      trigger.prNumber,
      trigger.type === "assigned" ? trigger.issueNumber : undefined,
      response.comment,
    );
  }

  let commentBody = normalizeComment(response.comment);
  if (skippedPaths.length > 0) {
    const warning = [
      "",
      "---",
      "⚠️ Skipped unsafe paths:",
      ...skippedPaths.map(pathValue => `- ${pathValue}`),
    ].join("\n");
    commentBody = normalizeStringValue(`${commentBody}\n${warning}`) ?? commentBody;
  }

  if (trigger.type !== "assigned") {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: trigger.issueNumber,
      body: commentBody,
    });
  }
}

// ─── Instruction parsing ─────────────────────────────────────────────────────

function extractInstruction(body: string): string {
  const match = body.match(/@flowai\s+([\s\S]+)/i);
  return match ? match[1].trim() : body.trim();
}

function labelToInstruction(labelName: string, body: string): string {
  const labelMap: Record<string, string> = {
    "bot-review": "Review this PR thoroughly. Check for bugs, security issues, code style, and suggest improvements.",
    "bot-fix": "Fix all issues mentioned in this PR or issue description.",
    "bot-triage": "Triage this issue: add appropriate labels, assess severity, ask clarifying questions if needed, and suggest a fix approach.",
    "bot-implement": "Implement what is described in this issue or PR description.",
  };
  const base = labelMap[labelName] ?? `Perform the action described by the label: ${labelName}`;
  return body ? `${base}\n\nContext:\n${body}` : base;
}

// ─── Context gathering ───────────────────────────────────────────────────────

async function gatherContext(
  owner: string,
  repo: string,
  trigger: { isPR: boolean; prNumber?: number; issueNumber: number },
) {
  const parts: string[] = [];

  try {
    const tree = execSync(
      `find ${REPO_ROOT} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.github/*' | head -80`,
      { encoding: "utf8" },
    );
    parts.push(`## Repo file tree\n\`\`\`\n${tree}\`\`\``);
  } catch {}

  if (trigger.isPR && trigger.prNumber) {
    try {
      const { data: files } = await octokit.pulls.listFiles({
        owner, repo, pull_number: trigger.prNumber, per_page: 30,
      });

      const diffSummary = files
        .map(f => `${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");
      parts.push(`## PR changed files\n${diffSummary}`);

      const patches = files
        .filter(f => f.patch)
        .slice(0, 10)
        .map(f => `### ${f.filename}\n\`\`\`diff\n${f.patch}\`\`\``)
        .join("\n\n");

      if (patches) parts.push(`## PR diffs\n${patches}`);
    } catch {}
  }

  try {
    if (trigger.isPR && trigger.prNumber) {
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: trigger.prNumber });
      parts.push(`## PR title\n${pr.title}\n\n## PR description\n${pr.body ?? "(none)"}`);
    } else {
      const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: trigger.issueNumber });
      parts.push(`## Issue title\n${issue.title}\n\n## Issue body\n${issue.body ?? "(none)"}`);
    }
  } catch {}

  try {
    const { data: comments } = await octokit.issues.listComments({
      owner, repo, issue_number: trigger.issueNumber, per_page: 10,
    });

    if (comments.length > 0) {
      const commentLog = comments.map(c => `**${c.user?.login}**: ${c.body}`).join("\n\n---\n\n");
      parts.push(`## Previous comments\n${commentLog}`);
    }
  } catch {}

  return parts.join("\n\n");
}

// ─── Agent loop ──────────────────────────────────────────────────────────────

async function agentLoop(instruction: string, context: string): Promise<BotResponse> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "## Instruction",
        instruction,
        "",
        "## Repository context",
        context,
      ].join("\n"),
    },
  ];

  let lastResponse = "";

  for (let round = 0; round < 3; round++) {
    const raw = await callLLM(messages);
    lastResponse = raw;
    messages.push({ role: "assistant", content: raw });

    if (!raw.includes("CONTINUE:")) break;
    messages.push({ role: "user", content: "Continue with the next step." });
  }

  return parseResponse(lastResponse);
}

// ─── STREAMING LLM ───────────────────────────────────────────────────────────

async function callLLM(messages: Message[], onProgress?: (chunk: string) => void): Promise<string> {
  const payload: any = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages,
    stream: true,
  };

  const res = await fetch(POLLINATIONS_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${core.getInput("pollinations_api_key")}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const reader = res.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      if (!part.startsWith("data:")) continue;

      const data = part.replace(/^data:\s*/, "").trim();
      if (data === "[DONE]") return accumulated;

      try {
        const json = JSON.parse(data);
        const chunk = json.choices?.[0]?.delta?.content || "";
        if (chunk) {
          accumulated += chunk;
          onProgress?.(chunk);
        }
      } catch {}
    }
  }

  return accumulated;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function parseResponse(raw: string): BotResponse {
  const trimmed = raw.trim();
  const candidates: string[] = [];
  const codeBlockMatch = trimmed.match(/```json\s*([\s\S]+?)\s*```/i);
  if (codeBlockMatch?.[1]) candidates.push(codeBlockMatch[1]);
  if (trimmed) candidates.push(trimmed);

  const extracted = extractJsonObject(trimmed);
  if (extracted) candidates.push(extracted);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed) return normalizeBotResponse(parsed, raw);
  }

  return { comment: raw };
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i++) {
    const char = value[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return value.slice(start, i + 1);
    }
  }

  return null;
}

function normalizeBotResponse(value: unknown, fallbackComment: string): BotResponse {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const comment =
    typeof record.comment === "string" && record.comment.trim()
      ? record.comment
      : fallbackComment;
  const commitMessage =
    typeof record.commitMessage === "string" && record.commitMessage.trim()
      ? record.commitMessage.trim()
      : undefined;
  const files = normalizeFileChanges(record.files);

  return { comment, files, commitMessage };
}

function normalizeFileChanges(value: unknown): FileChange[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const normalized: FileChange[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const file = entry as Partial<FileChange>;
    if (typeof file.path !== "string" || !file.path.trim()) continue;
    if (file.action !== "create" && file.action !== "update" && file.action !== "delete") continue;
    const requiresContent = file.action === "create" || file.action === "update";
    if (requiresContent) {
      if (typeof file.content !== "string") continue;
      normalized.push({
        path: file.path.trim(),
        action: file.action,
        content: file.content,
      });
      continue;
    }

    normalized.push({
      path: file.path.trim(),
      action: file.action,
      content: "",
    });
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.length > MAX_COMMENT_LENGTH) {
    const available = Math.max(0, MAX_COMMENT_LENGTH - TRUNCATION_SUFFIX_LENGTH);
    const truncated = trimmed.substring(0, available);

    return `${truncated}${TRUNCATION_SUFFIX}`;
  }

  return trimmed;
}

function normalizeComment(comment: unknown): string {
  if (typeof comment === "string") {
    const normalized = normalizeStringValue(comment);
    if (normalized) return normalized;
  } else if (typeof comment === "object" && comment !== null) {
    try {
      const normalized = normalizeStringValue(JSON.stringify(comment));
      if (normalized) return normalized;
    } catch {
      return OBJECT_FALLBACK_MESSAGE;
    }
  } else if (comment !== undefined && comment !== null) {
    const normalized = normalizeStringValue(String(comment));
    if (normalized) return normalized;
  }

  return DEFAULT_COMMENT_MESSAGE;
}

// ─── File changes ────────────────────────────────────────────────────────────

async function applyFileChanges(
  owner: string,
  repo: string,
  files: FileChange[],
  commitMessage: string,
  prNumber?: number,
  issueNumber?: number,
  prComment?: string,
): Promise<string[]> {
  const skippedPaths: string[] = [];
  execFileSync("git", ["config", "user.name", "flowai[bot]"], { cwd: REPO_ROOT });
  execFileSync("git", ["config", "user.email", "flowai[bot]@users.noreply.github.com"], { cwd: REPO_ROOT });

  for (const f of files) {
    const safePath = sanitizeRelativePath(f.path);
    if (!safePath) {
      console.log(`Skipping unsafe path: ${f.path}`);
      skippedPaths.push(f.path);
      continue;
    }

    const fullPath = path.join(REPO_ROOT_PATH, safePath);

    if (f.action === "delete") {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        execFileSync("git", ["rm", "-f", safePath], { cwd: REPO_ROOT });
      }
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.content);
      execFileSync("git", ["add", safePath], { cwd: REPO_ROOT });
    }
  }

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (!status) {
    console.log("No file changes detected, skipping commit.");
    return skippedPaths;
  }

  const sanitizedCommitMessage = sanitizeCommitMessage(commitMessage);
  execFileSync("git", ["commit", "-m", sanitizedCommitMessage], { cwd: REPO_ROOT });
  execFileSync("git", ["push"], { cwd: REPO_ROOT });
  return skippedPaths;
}

function sanitizeRelativePath(filePath: string): string | null {
  const trimmed = filePath.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return null;
  if (path.isAbsolute(trimmed)) return null;
  if (trimmed.includes("\0")) return null;

  const normalized = path.normalize(trimmed).replace(/\\/g, "/");
  if (normalized === "." || normalized === "..") return null;
  if (normalized.startsWith("../")) return null;

  const segments = normalized.split("/");
  if (segments.includes("..")) return null;
  if (segments.some(segment => BLOCKED_PATH_SEGMENTS.has(segment))) return null;
  const fileName = path.posix.basename(normalized);
  if (BLOCKED_FILE_PREFIXES.some(prefix => fileName.startsWith(prefix))) return null;

  const resolved = path.resolve(REPO_ROOT_PATH, normalized);
  if (!isWithinRepoPath(resolved)) return null;

  return normalized;
}

function sanitizeCommitMessage(message: string): string {
  const cleaned = message
    .replace(/[\r\n\0]+/g, " ")
    .replace(/[`$;|&<>"'(){}\[\]*?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.slice(0, MAX_COMMIT_MESSAGE_LENGTH);
  return truncated || "flowai: apply changes";
}

function isWithinRepoPath(resolvedPath: string): boolean {
  const relative = path.relative(REPO_ROOT_PATH, resolvedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ─── Reactions ───────────────────────────────────────────────────────────────

async function postThinkingReaction(owner: string, repo: string, payload: any, eventName: string) {
  try {
    if (eventName === "issue_comment") {
      await octokit.reactions.createForIssueComment({
        owner, repo, comment_id: payload.comment.id, content: "eyes",
      });
    }
  } catch {}
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch(console.error);
