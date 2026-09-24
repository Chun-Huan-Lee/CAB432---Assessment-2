# End-to-end checks after deployment. Prints what to show in the demo.
. "$PSScriptRoot\config.ps1"
$state = Get-State
$secret = (Invoke-Aws secretsmanager get-secret-value --secret-id $SecretName).SecretString | ConvertFrom-Json

Step "1. MCP server is a separate, authenticated component"
$mcpHeaders = @{ Authorization = "Bearer $($secret.mcpApiKey)"; Accept = "application/json, text/event-stream"; "x-custodian-caller" = "smoke-test" }
$init = @{ jsonrpc = "2.0"; id = 1; method = "initialize"; params = @{ protocolVersion = "2025-06-18"; capabilities = @{}; clientInfo = @{ name = "smoke"; version = "1" } } } | ConvertTo-Json -Depth 5
$r = Invoke-RestMethod -Method Post -Uri "$($state.apiBaseUrl)/mcp" -Headers $mcpHeaders -Body $init -ContentType "application/json"
Ok "initialize -> $($r.result.serverInfo.name) $($r.result.serverInfo.version)"
$list = @{ jsonrpc = "2.0"; id = 2; method = "tools/list" } | ConvertTo-Json
$mcpHeaders["mcp-protocol-version"] = "2025-06-18"
$tools = Invoke-RestMethod -Method Post -Uri "$($state.apiBaseUrl)/mcp" -Headers $mcpHeaders -Body $list -ContentType "application/json"
Ok "tools/list -> $(($tools.result.tools | ForEach-Object { $_.name }) -join ', ')"
try {
  Invoke-RestMethod -Method Post -Uri "$($state.apiBaseUrl)/mcp" -Body $list -ContentType "application/json" | Out-Null
  Warn "MCP accepted a request WITHOUT the key"
} catch { Ok "Request without the bearer key rejected (401)" }

Step "2. Heartbeat (manual invoke for testing; the schedule does this on its own)"
$payload = Write-JsonFile "hb-payload.json" @{ source = "manual-smoke-test" }
$outFile = Join-Path $WorkDir "hb-out.json"
& aws lambda invoke --function-name $LambdaNames.heartbeat --payload $payload --cli-binary-format raw-in-base64-out `
  --cli-read-timeout 310 --profile $AwsProfile --region $Region $outFile | Out-Null
Get-Content $outFile -Raw | Write-Host

Step "3. Recent async jobs (DynamoDB)"
$keys = Write-JsonFile "jobs-query.json" @{ ":pk" = @{ S = "REPO#$GitHubOwner/$GitHubRepo" }; ":p" = @{ S = "JOB#" } }
$jobs = Invoke-Aws dynamodb query --table-name $TableName --key-condition-expression "PK = :pk AND begins_with(SK, :p)" --expression-attribute-values $keys
$jobs.Items | ForEach-Object { Write-Host "  $($_.type.S) $($_.target.S) -> $($_.status.S) ($($_.updatedAt.S))" }

Step "4. Chat UI"
if ($state.agentPublicIp) { Ok "http://$($state.agentPublicIp):$ContainerPort" } else { Warn "Run 08-ecs.ps1" }
Write-Host "`nUseful log commands:" -ForegroundColor Cyan
foreach ($name in $LambdaNames.Values) { Write-Host "  aws logs tail /aws/lambda/$name --since 30m --follow --profile $AwsProfile" }
Write-Host "  aws logs tail $LogGroupName --since 30m --follow --profile $AwsProfile"
