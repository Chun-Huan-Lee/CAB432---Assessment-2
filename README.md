# Repository Custodian (CAB432 Assessment 2, Track B)

An AI agent that looks after a small GitHub repository: it triages new issues, investigates flagged ones, keeps the docs in line with the code (via pull requests), and answers questions about the repository in a chat UI, grounded in a vector store.

Student: Chun-Huan Lee (n12228591). Region `ap-southeast-2`, CAB432 shared account. All resources are tagged `qut-username=n12228591@qut.edu.au`, `purpose=assessment 2`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the reasoning behind it.

## Repository layout

| Path | What it is |
|------|------------|
| `index.html`, `web/` | ACP WebUI (provided client) plus Cognito sign-in and visible tool activity |
| `backend/agent-server/` | Chat agent container for ECS Fargate: serves the UI, ACP over WebSocket |
| `backend/mcp/` | MCP server (Lambda behind API Gateway), the only data gateway for the model |
| `backend/webhook/` | GitHub webhook receiver, verifies HMAC and enqueues jobs |
| `backend/worker/` | SQS consumer that runs the agent for triage, investigation and doc drift |
| `backend/indexer/` | SQS consumer that chunks, embeds and indexes repository snapshots |
| `backend/heartbeat/` | EventBridge-scheduled autonomous run with a memory record |
| `backend/presignup/` | Cognito pre sign-up trigger (QUT emails only) |
| `backend/shared/` | Agent loop, MCP client, DynamoDB store, S3 Vectors, GitHub client |
| `infra/` | PowerShell deployment scripts (AWS CLI) |
| `sandbox-repo/` | The small project the custodian manages (push it to its own GitHub repo) |
| `server/deterministic-acp.ts` | Provided deterministic ACP test agent (still works with `npm run dev`) |

## Deploying from scratch (Windows PowerShell 7)

1. **Create the managed repo on GitHub**, for example `n12228591-custodian-sandbox`, then push the sandbox project:
   ```powershell
   cd sandbox-repo
   git init -b main; git add .; git commit -m "tiny-notes-api"
   git remote add origin https://github.com/Chun-Huan-Lee/n12228591-custodian-sandbox.git
   git push -u origin main
   cd ..
   ```
2. **Create a fine-grained GitHub token** limited to that one repository with read/write on Contents, Issues, Pull requests and Webhooks (Metadata read is automatic).
3. **Edit `infra/config.ps1`** (repo name, models, ECS role names if known).
4. **Sign in and check the environment:**
   ```powershell
   aws sso login --profile cab432-student-n12228591
   npm ci
   cd infra
   .\00-preflight.ps1
   ```
5. **Deploy** (each step is idempotent, re-run after fixing any error):
   ```powershell
   .\deploy-all.ps1          # prompts once for the GitHub token
   .\06-cognito.ps1 -CreateUser
   .\09-github.ps1 -SeedIssues
   .\12-smoke-test.ps1
   ```
6. Open the chat URL printed by `08-ecs.ps1` and sign in.
7. Submit `submission-agent-infra.yml` (written by `10-submission.ps1`) to Gradescope.

Between work sessions run `.\99-pause.ps1` to stop the Fargate task and heartbeat, and `.\99-pause.ps1 -Resume` before the demo. Resume at least a few hours before presenting so there is a scheduled run to show.

## Local development

```powershell
npm test                        # unit + integration tests (no AWS needed)
npm run dev; npm run server     # original WebUI + deterministic agent
$env:CONFIG_PARAMETER="/n12228591/a2/config"; $env:SECRET_ID="n12228591-a2-secrets"
$env:AWS_PROFILE="cab432-student-n12228591"; $env:AUTH_DISABLED="true"
npm run agent:dev               # real agent locally against deployed AWS, http://localhost:8080
```
