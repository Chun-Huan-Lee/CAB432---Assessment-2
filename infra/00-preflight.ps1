# Checks the environment BEFORE creating anything. Safe to run repeatedly.
. "$PSScriptRoot\config.ps1"

Step "AWS CLI and identity"
$version = (& aws --version) 2>&1
Write-Host "  $version"
$identity = Test-Aws sts get-caller-identity
if (-not $identity) { throw "Not signed in. Run: aws sso login --profile $AwsProfile" }
Ok "Signed in as $($identity.Arn)"
if ($identity.Account -ne $AccountId) { Warn "Account $($identity.Account) differs from config ($AccountId)" }

Step "Tools"
foreach ($tool in @("node", "npm", "docker")) {
  if (Get-Command $tool -ErrorAction SilentlyContinue) { Ok "$tool found" } else { Warn "$tool NOT found (needed for build/deploy)" }
}
$s3vectorsHelp = (& aws s3vectors help 2>&1) -join " "
if ($s3vectorsHelp -match "Invalid choice") { Warn "AWS CLI too old for S3 Vectors. Update AWS CLI v2 to the latest version." } else { Ok "AWS CLI supports s3vectors" }

Step "Bedrock model access (one tiny call each)"
$embedBody = Write-JsonFile "preflight-embed.json" @{ inputText = "hello"; dimensions = $EmbedDims; normalize = $true }
$embedOut = Join-Path $WorkDir "preflight-embed-out.json"
& aws bedrock-runtime invoke-model --model-id $EmbedModelId --body $embedBody --cli-binary-format raw-in-base64-out `
  --profile $AwsProfile --region $Region $embedOut 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "Embeddings model $EmbedModelId works" } else { Warn "Cannot invoke $EmbedModelId (check Canvas model list / Bedrock permissions)" }

$messages = Write-JsonFile "preflight-messages.json" @(@{ role = "user"; content = @(@{ text = "Reply with the word OK." }) })
$chat = Test-Aws bedrock-runtime converse --model-id $ChatModelId --messages $messages
if ($chat) { Ok "Chat model $ChatModelId replied: $($chat.output.message.content[0].text)" } else { Warn "Cannot invoke $ChatModelId (check Canvas model list)" }

Step "IAM roles visible to you (pick the ECS ones for config.ps1)"
$roles = Test-Aws iam list-roles --query "Roles[].RoleName"
if ($roles) {
  $roles | Where-Object { $_ -match "(?i)cab432|ecs|lambda" } | ForEach-Object { Write-Host "  - $_" }
} else { Warn "iam:ListRoles not permitted. Get the ECS role names from Canvas." }

Step "Default VPC for the Fargate task"
$vpc = Test-Aws ec2 describe-vpcs --filters Name=is-default,Values=true
if ($vpc -and $vpc.Vpcs.Count -gt 0) {
  $vpcId = $vpc.Vpcs[0].VpcId
  $subnets = Invoke-Aws ec2 describe-subnets --filters "Name=vpc-id,Values=$vpcId"
  Ok "Default VPC $vpcId with subnets: $(($subnets.Subnets | ForEach-Object { $_.SubnetId }) -join ', ')"
} else { Warn "No default VPC visible. Set `$SubnetIds and `$SecurityGroupId in config.ps1 (ask teaching staff)." }

Step "Quotas that bit Assessment 1"
$tables = Test-Aws dynamodb list-tables --max-items 1
if ($tables) { Ok "DynamoDB reachable (this project needs only ONE table)" }

Write-Host "`nPreflight finished. Fix any '!!' lines before running deploy-all.ps1." -ForegroundColor Cyan
