# Flow AI Bot

An AI coding assistant GitHub Action powered by [Pollinations](https://pollinations.ai). Mention `@flowai` in any PR or issue comment to review code, fix bugs, implement features, or build entire codebases from scratch.

## Usage

Add this workflow to your repo at `.github/workflows/flow.yml`:

```yaml
name: Flow

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [labeled]
  pull_request:
    types: [labeled]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  bot:
    runs-on: ubuntu-latest
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@flowai')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@flowai')) ||
      (github.event_name == 'issues' && startsWith(github.event.label.name, 'bot-')) ||
      (github.event_name == 'pull_request' && startsWith(github.event.label.name, 'bot-'))

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: your-username/flow@v1
        with:
          pollinations_api_key: ${{ secrets.POLLINATIONS_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Then add your Pollinations API key as a repository secret named `POLLINATIONS_API_KEY`. Get one at [enter.pollinations.ai](https://enter.pollinations.ai).

## Examples

```
@flowai review this PR for security issues
@flowai fix the failing tests in auth.test.ts
@flowai implement a rate limiter middleware
@flowai explain what this function does
@flowai build a full REST API for user authentication
```

You can also trigger the bot by adding labels to issues or PRs:

| Label | Action |
|-------|--------|
| `bot-review` | Full code review |
| `bot-fix` | Fix issues in the description |
| `bot-implement` | Implement the described feature |
| `bot-triage` | Triage and assess the issue |

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `pollinations_api_key` | Yes | — | Your Pollinations API key |
| `github_token` | Yes | `${{ github.token }}` | GitHub token for API access |
| `model` | No | `glm` | Pollinations model to use |
| `max_tokens` | No | `32000` | Max tokens for AI response |

### Available models

Any model supported by Pollinations works: `glm`, `claude`, `openai-large`, `gemini`, `deepseek`, and more. See the [Pollinations docs](https://gen.pollinations.ai/v1/models) for the full list.

## License

MIT
