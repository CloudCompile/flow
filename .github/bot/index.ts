import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const POLLINATIONS_API = "https://gen.pollinations.ai/v1/chat/completions";
const MODEL = core.getInput("model") || "glm";
const MAX_TOKENS = parseInt(core.getInput("max_tokens") || "32000", 10);
const REPO_ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();

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
    type: "pr_comment" | "issue_comment" | "label";
    instruction: string;
    issueNumber: number;
    isPR: boolean;
    prNumber?: number;
  };

  // Parse trigger
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

  // Post a "thinking" reaction so users know the bot is working
  await postThinkingReaction(owner, repo, payload, eventName);

  // Gather full context
  const context = await gatherContext(owner, repo, trigger);

  // Run the agentic loop
  const response = await agentLoop(trigger.instruction, context);

  // Apply file changes if any
  if (response.files && response.files.length > 0) {
    await applyFileChanges(owner, repo, response.files, response.commitMessage || `bot: ${trigger.instruction.slice(0, 72)}`, trigger.prNumber);
  }

  // Post the comment
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: trigger.issueNumber,
    body: response.comment,
  });
}

// ─── Instruction parsing ─────────────────────────────────────────────────────

function extractInstruction(body: string): string {
  // Everything after @bot
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

async function gatherContext(owner: string, repo: string, trigger: { isPR: boolean; prNumber?: number; issueNumber: number }) {
  const parts: string[] = [];

  // Repo file tree (top-level + src)
  try {
    const tree = execSync(`find ${REPO_ROOT} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.github/*' | head -80`, { encoding: "utf8" });
    parts.push(`## Repo file tree\n\`\`\`\n${tree}\`\`\``);
  } catch {}

  // If it's a PR, get the diff
  if (trigger.isPR && trigger.prNumber) {
    try {
      const { data: files } = await octokit.pulls.listFiles({
        owner, repo, pull_number: trigger.prNumber, per_page: 30,
      });
      const diffSummary = files.map(f => `${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
      parts.push(`## PR changed files\n${diffSummary}`);

      // Full patches for changed files (capped to avoid context overflow)
      const patches = files
        .filter(f => f.patch && f.filename.match(/\.(ts|tsx|js|jsx|py|go|rs|rb|java|cs|cpp|c|h|md|json|yaml|yml|toml|env\.example)$/))
        .slice(0, 10)
        .map(f => `### ${f.filename}\n\`\`\`diff\n${f.patch}\`\`\``)
        .join("\n\n");
      if (patches) parts.push(`## PR diffs\n${patches}`);
    } catch {}
  }

  // Issue / PR description
  try {
    if (trigger.isPR && trigger.prNumber) {
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: trigger.prNumber });
      parts.push(`## PR title\n${pr.title}\n\n## PR description\n${pr.body ?? "(none)"}`);
    } else {
      const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: trigger.issueNumber });
      parts.push(`## Issue title\n${issue.title}\n\n## Issue body\n${issue.body ?? "(none)"}`);
    }
  } catch {}

  // Previous comments (last 10 for context)
  try {
    const { data: comments } = await octokit.issues.listComments({
      owner, repo, issue_number: trigger.issueNumber, per_page: 10,
    });
    if (comments.length > 0) {
      const commentLog = comments.map(c => `**${c.user?.login}**: ${c.body}`).join("\n\n---\n\n");
      parts.push(`## Previous comments\n${commentLog}`);
    }
  } catch {}

  // Read relevant source files mentioned in the issue/PR
  try {
    const allText = parts.join("\n");
    const fileMatches = allText.match(/[\w/.-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java|cs|cpp|c|h)/g) ?? [];
    const uniqueFiles = [...new Set(fileMatches)].slice(0, 5);
    for (const f of uniqueFiles) {
      const fullPath = path.join(REPO_ROOT, f);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf8").slice(0, 3000);
        parts.push(`## File: ${f}\n\`\`\`\n${content}\`\`\``);
      }
    }
  } catch {}

  return parts.join("\n\n");
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function agentLoop(instruction: string, context: string): Promise<BotResponse> {
  const systemPrompt = `You are an expert AI coding assistant embedded in a GitHub repository as a bot.
You can review code, answer questions, fix bugs, implement features, and write entire codebases.

When you need to create or modify files, respond with a JSON block in this exact format:
\`\`\`json
{
  "comment": "The markdown comment to post on the PR/issue (required)",
  "commitMessage": "feat: short commit message",
  "files": [
    { "path": "src/example.ts", "content": "full file content here", "action": "create" },
    { "path": "src/old.ts", "content": "", "action": "delete" }
  ]
}
\`\`\`

Action values: "create" (new file or overwrite), "update" (same as create), "delete" (remove file).

If you only need to post a comment without changing files, just return:
\`\`\`json
{ "comment": "Your markdown comment here" }
\`\`\`

Rules:
- Write complete, production-quality code — never truncate with "..." or "rest of the file"
- Be direct and decisive — make the change, don't ask for permission
- For large tasks, do them fully in one shot
- The comment field supports full GitHub markdown including code blocks
- Keep commit messages concise (conventional commits style)
- Never include secrets, API keys, or credentials`;

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `## Instruction\n${instruction}\n\n## Repository context\n${context}`,
    },
  ];

  let lastResponse = "";

  // Up to 3 agentic rounds (for multi-step tasks)
  for (let round = 0; round < 3; round++) {
    const raw = await callLLM(messages);
    lastResponse = raw;
    messages.push({ role: "assistant", content: raw });

    // Check if the model wants to do more work
    if (!raw.includes("CONTINUE:")) break;

    // If model signals it wants another round, pass it back
    messages.push({
      role: "user",
      content: "Continue with the next step.",
    });
  }

  return parseResponse(lastResponse);
}

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callLLM(messages: Message[]): Promise<string> {
  const res = await fetch(POLLINATIONS_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${core.getInput("pollinations_api_key")}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pollinations API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseResponse(raw: string): BotResponse {
  // Extract JSON block from response
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as BotResponse;
      if (parsed.comment) return parsed;
    } catch {}
  }

  // Fallback: treat the whole response as a comment
  return { comment: raw };
}

// ─── File application ─────────────────────────────────────────────────────────

async function applyFileChanges(
  owner: string,
  repo: string,
  files: FileChange[],
  commitMessage: string,
  prNumber?: number,
) {
  // Configure git
  execSync(`git config user.name "github-actions[bot]"`, { cwd: REPO_ROOT });
  execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`, { cwd: REPO_ROOT });

  // If it's a PR, check out the PR branch
  if (prNumber) {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    const branch = pr.head.ref;
    execSync(`git fetch origin ${branch}`, { cwd: REPO_ROOT });
    execSync(`git checkout ${branch}`, { cwd: REPO_ROOT });
  }

  // Apply file changes
  for (const f of files) {
    const fullPath = path.join(REPO_ROOT, f.path);
    if (f.action === "delete") {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        execSync(`git rm -f "${f.path}"`, { cwd: REPO_ROOT });
      }
    } else {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.content, "utf8");
      execSync(`git add "${f.path}"`, { cwd: REPO_ROOT });
    }
  }

  // Commit and push
  const statusOut = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" });
  if (statusOut.trim()) {
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { cwd: REPO_ROOT });
    execSync("git push", { cwd: REPO_ROOT });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function postThinkingReaction(owner: string, repo: string, payload: any, eventName: string) {
  try {
    const commentId =
      eventName === "pull_request_review_comment"
        ? payload.comment.id
        : payload.comment?.id;
    if (!commentId) return;

    if (eventName === "pull_request_review_comment") {
      await octokit.reactions.createForPullRequestReviewComment({
        owner, repo, comment_id: commentId, content: "eyes",
      });
    } else {
      await octokit.reactions.createForIssueComment({
        owner, repo, comment_id: commentId, content: "eyes",
      });
    }
  } catch {}
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch(e => {
  console.error(e);
  process.exit(1);
});
