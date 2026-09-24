# Writes submission-agent-infra.yml from the recorded resource ARNs and checks tags.
. "$PSScriptRoot\config.ps1"
$state = Get-State

$entries = [System.Collections.Generic.List[object]]::new()
function Add-Entry([string] $Type, [string] $Arn, [string] $Description) {
  if ($Arn) { $entries.Add(@{ type = $Type; arn = $Arn; description = $Description }) } else { Warn "Missing ARN for $Type ($Description)" }
}

Add-Entry "Bedrock model" $ChatModelId "Amazon Nova Lite foundation model that reasons, calls MCP tools and reads screenshots for the chat, worker and heartbeat agents."
Add-Entry "Bedrock model" $EmbedModelId "Titan Text Embeddings V2 model that turns repository docs, code and issues into vectors for retrieval."
Add-Entry "ECS service" $state.ecsServiceArn "Fargate service running the ACP chat agent container that serves the web UI and streams Bedrock answers over WebSocket."
Add-Entry "ECS cluster" $state.ecsClusterArn "Cluster that hosts the chat agent Fargate service."
Add-Entry "ECS task definition" $state.taskDefinitionArn "Container definition for the chat agent (image, port 8080, roles, CloudWatch logging)."
Add-Entry "ECR repository" $state.ecrRepoArn "Stores the chat agent container images deployed to ECS."
Add-Entry "Vector store" $state.vectorBucketArn "S3 Vectors bucket holding embeddings of the repository README, docs, code and past issues."
Add-Entry "Vector store" $state.vectorIndexArn "S3 Vectors index (1024-dim, cosine) queried for nearest-neighbour context before the agent answers."
Add-Entry "MCP server" "$($state.apiBaseUrl)/mcp" "Stateless Streamable HTTP MCP endpoint exposing GitHub, DynamoDB and vector search to the model as 16 tools."
Add-Entry "Lambda function" $state.lambda_mcp "MCP server implementation behind API Gateway; the only component that touches repository data for the model."
Add-Entry "API Gateway" $state.apiStageArn "HTTP API that exposes the MCP server and receives signed GitHub webhooks."
Add-Entry "Lambda function" $state.lambda_webhook "Verifies GitHub webhook signatures and turns issue and push events into queued jobs."
Add-Entry "Lambda function" $state.lambda_worker "Consumes the jobs queue and runs the agent to triage issues, investigate flagged issues and fix drifted docs via PRs."
Add-Entry "Lambda function" $state.lambda_indexer "Chunks and embeds each new repository snapshot and writes the vectors to S3 Vectors."
Add-Entry "Lambda function" $state.lambda_heartbeat "Scheduled agent run that re-snapshots the repo, queues untriaged issues and writes a digest memory record."
Add-Entry "Lambda function" $state.lambda_presignup "Cognito pre sign-up trigger that only allows QUT emails and auto-confirms them."
Add-Entry "SQS queue" $state.jobsQueueArn "Decouples slow agent work (triage, investigation, doc drift, snapshot sync) from webhooks, chat and heartbeat."
Add-Entry "SQS queue" $state.jobsDlqArn "Dead-letter queue for jobs that failed three times."
Add-Entry "SQS queue" $state.ingestQueueArn "Buffers S3 snapshot-created events for the indexer Lambda."
Add-Entry "SQS queue" $state.ingestDlqArn "Dead-letter queue for snapshots that could not be indexed."
Add-Entry "EventBridge rule" $state.heartbeatRuleArn "Schedule that invokes the heartbeat agent autonomously."
Add-Entry "EventBridge rule" $state.snapshotRuleArn "Routes S3 Object Created events for snapshots/ to the ingest queue."
Add-Entry "Secrets Manager secret" $state.secretArn "GitHub token, GitHub webhook signing secret and the MCP bearer key."
Add-Entry "SSM parameter" $state.configParamArn "Non-secret JSON configuration (model ids, table, bucket, queue URL, MCP endpoint)."
Add-Entry "S3 bucket" $state.bucketArn "Stores repository snapshots, heartbeat digest reports and images uploaded in chat."
Add-Entry "DynamoDB table" $state.tableArn "Single-table store for repository, snapshot, chunk, issue triage, job, doc check, agent run and chat session records."
Add-Entry "Cognito user pool" $state.userPoolArn "User identity for the chat front end; the agent verifies the ID token before accepting a WebSocket."
Add-Entry "CloudWatch log group" $state.logGroupArn "Logs from the chat agent container."

$lines = @("cloudInfrastructure:")
foreach ($entry in $entries) {
  $lines += "  - type: $($entry.type)"
  $lines += "    arn: `"$($entry.arn)`""
  $lines += "    description: `"$($entry.description -replace '"', "'")`""
}
$lines += "metaData:"
$lines += "  track: `"B`""
$lines += "  qutUsernameTag: $QutEmail"
$out = Join-Path $RepoRoot "submission-agent-infra.yml"
Set-Content -Path $out -Value ($lines -join "`n") -Encoding ascii
Ok "Wrote $out ($($entries.Count) resources)"

Step "Tag check (resources tagged purpose=assessment 2 for $QutEmail)"
$tagged = Test-Aws resourcegroupstaggingapi get-resources --tag-filters "Key=qut-username,Values=$QutEmail" "Key=purpose,Values=assessment 2"
if ($tagged) {
  $taggedArns = @($tagged.ResourceTagMappingList | ForEach-Object { $_.ResourceARN })
  foreach ($entry in $entries) {
    if ($entry.arn -notlike "arn:*" -or $entry.type -eq "Bedrock model") { continue }
    $match = $taggedArns | Where-Object { $_ -eq $entry.arn -or $entry.arn.StartsWith($_) -or $_.StartsWith($entry.arn) }
    if ($match) { Ok "$($entry.type): tagged" } else { Warn "$($entry.type) $($entry.arn) not found in tag search (check it in the console)" }
  }
} else { Warn "tag:GetResources not permitted; check tags in the console or AWS Resource Explorer." }
