# =============================================================================
# Repository Custodian (CAB432 A2, Track B): shared deployment settings.
# Every other script dot-sources this file:  . "$PSScriptRoot\config.ps1"
# Edit ONLY the "EDIT ME" section.
# =============================================================================

# ------------------------------- EDIT ME -------------------------------------
$StudentId      = "n12228591"
$QutEmail       = "n12228591@qut.edu.au"
$AwsProfile     = "cab432-student-n12228591"
$Region         = "ap-southeast-2"
$AccountId      = "901444280953"

# GitHub repository the custodian manages (create it first, see README).
$GitHubOwner    = "Chun-Huan-Lee"
$GitHubRepo     = "n12228591-custodian-sandbox"

# Bedrock models (check the Canvas "AWS services available" page).
$ChatModelId    = "amazon.nova-lite-v1:0"         # multimodal: can read screenshots
$EmbedModelId   = "amazon.titan-embed-text-v2:0"
$EmbedDims      = 1024

# Pre-provisioned IAM roles (students cannot create roles).
$LambdaRoleName       = "CAB432-Lambda-Role"
# Leave empty to auto-detect from `aws iam list-roles`, or fill in from Canvas.
$EcsExecutionRoleName = ""
$EcsTaskRoleName      = ""

# Networking for the Fargate task. Leave empty to use the default VPC.
$SubnetIds        = @()
$SecurityGroupId  = ""

# Heartbeat schedule (EventBridge). rate(1 hour) is cheap; use rate(15 minutes) for the demo day.
$HeartbeatSchedule = "rate(1 hour)"
# -----------------------------------------------------------------------------

$Prefix           = "$StudentId-a2"
$TableName        = "$Prefix-custodian"
$BucketName       = "$Prefix-custodian"
$VectorBucketName = "$Prefix-vectors"
$VectorIndexName  = "repo-context"
$JobsQueueName    = "$Prefix-jobs"
$JobsDlqName      = "$Prefix-jobs-dlq"
$IngestQueueName  = "$Prefix-ingest"
$IngestDlqName    = "$Prefix-ingest-dlq"
$SecretName       = "$Prefix-secrets"
$ConfigParamName  = "/$StudentId/a2/config"
$ApiName          = "$Prefix-api"
$UserPoolName     = "$Prefix-users"
$UserPoolClient   = "$Prefix-web"
$HeartbeatRule    = "$Prefix-heartbeat"
$SnapshotRule     = "$Prefix-snapshot-created"
$EcrRepoName      = "$Prefix-agent"
$ClusterName      = "$Prefix-cluster"
$ServiceName      = "$Prefix-agent"
$TaskFamily       = "$Prefix-agent"
$LogGroupName     = "/ecs/$Prefix-agent"
$ContainerPort    = 8080

$LambdaNames = [ordered]@{
  mcp       = "$Prefix-mcp"
  webhook   = "$Prefix-webhook"
  worker    = "$Prefix-worker"
  indexer   = "$Prefix-indexer"
  heartbeat = "$Prefix-heartbeat"
  presignup = "$Prefix-presignup"
}
# name = @(timeoutSeconds, memoryMB)
$LambdaSizing = @{
  mcp       = @(29, 512)
  webhook   = @(10, 256)
  worker    = @(300, 512)
  indexer   = @(600, 512)
  heartbeat = @(300, 512)
  presignup = @(5, 128)
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WorkDir  = Join-Path $PSScriptRoot ".state"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

# ------------------------------- helpers -------------------------------------

function Invoke-Aws {
  <# Runs the AWS CLI with the project profile/region and returns parsed JSON.
     Throws with the CLI's error text when the command fails. #>
  $errFile = Join-Path $WorkDir "aws-stderr.txt"
  $output = & aws @args --profile $AwsProfile --region $Region --output json 2> $errFile
  if ($LASTEXITCODE -ne 0) {
    $message = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
    throw "aws $($args -join ' ') failed: $message"
  }
  $text = ($output -join "`n").Trim()
  if ($text) { return $text | ConvertFrom-Json }
  return $null
}

function Test-Aws {
  <# Same as Invoke-Aws but returns $null instead of throwing (existence checks). #>
  try { return Invoke-Aws @args } catch { return $null }
}

function Test-AwsSuccess {
  <# $true when the CLI command exits 0 (for commands with empty output, e.g. head-bucket). #>
  try { Invoke-Aws @args | Out-Null; return $true } catch { return $false }
}

function Write-JsonFile {
  <# Writes an object as ASCII JSON (no BOM) and returns a file:// URI for the CLI. #>
  param([Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] $Object)
  $path = Join-Path $WorkDir $Name
  $json = if ($Object -is [string]) { $Object } else { ConvertTo-Json -InputObject $Object -Depth 30 -Compress }
  Set-Content -Path $path -Value $json -Encoding ascii -NoNewline
  return "file://" + ($path -replace "\\", "/")
}

# Tag files in the three shapes AWS services expect.
$TagPairs = [ordered]@{ "qut-username" = $QutEmail; "purpose" = "assessment 2" }
$TagsList = Write-JsonFile "tags-list.json" @($TagPairs.GetEnumerator() | ForEach-Object { @{ Key = $_.Key; Value = $_.Value } })
$TagsMap  = Write-JsonFile "tags-map.json"  $TagPairs
$TagsEcs  = Write-JsonFile "tags-ecs.json"  @($TagPairs.GetEnumerator() | ForEach-Object { @{ key = $_.Key; value = $_.Value } })

function Get-State {
  $path = Join-Path $WorkDir "state.json"
  if (Test-Path $path) { return Get-Content $path -Raw | ConvertFrom-Json -AsHashtable }
  return @{}
}

function Set-State([string] $Key, $Value) {
  $state = Get-State
  $state[$Key] = $Value
  $state | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $WorkDir "state.json") -Encoding ascii
}

function Update-AppConfig([hashtable] $Changes) {
  <# Merges changes into the JSON config stored in Parameter Store. #>
  $current = @{}
  $param = Test-Aws ssm get-parameter --name $ConfigParamName
  if ($param) { $current = $param.Parameter.Value | ConvertFrom-Json -AsHashtable }
  foreach ($key in $Changes.Keys) { $current[$key] = $Changes[$key] }
  $valueFile = Write-JsonFile "config-value.json" ($current | ConvertTo-Json -Depth 10 -Compress)
  Invoke-Aws ssm put-parameter --name $ConfigParamName --type String --overwrite --value $valueFile | Out-Null
  Write-Host "  Parameter Store $ConfigParamName updated: $($Changes.Keys -join ', ')"
}

function Step([string] $Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Ok([string] $Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Warn([string] $Text) { Write-Host "  !!  $Text" -ForegroundColor Yellow }

$LambdaRoleArn = "arn:aws:iam::${AccountId}:role/$LambdaRoleName"
