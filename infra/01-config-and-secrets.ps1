# Secrets Manager secret (credentials) + Parameter Store parameter (settings).
. "$PSScriptRoot\config.ps1"

function New-RandomKey([int] $Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ([Convert]::ToHexString($buffer)).ToLower()
}

Step "Secrets Manager: $SecretName"
$existing = Test-Aws secretsmanager describe-secret --secret-id $SecretName
if ($existing) {
  Ok "Secret already exists ($($existing.ARN)). Re-run with -RotateGitHubToken to replace the token."
  $secretArn = $existing.ARN
  if ($args -contains "-RotateGitHubToken") {
    $current = (Invoke-Aws secretsmanager get-secret-value --secret-id $SecretName).SecretString | ConvertFrom-Json -AsHashtable
    $current.githubToken = (Read-Host "New GitHub fine-grained token" -MaskInput)
    $file = Write-JsonFile "secret-value.json" ($current | ConvertTo-Json -Compress)
    Invoke-Aws secretsmanager put-secret-value --secret-id $SecretName --secret-string $file | Out-Null
    Ok "GitHub token rotated"
  }
} else {
  Write-Host "  Paste the GitHub fine-grained token for $GitHubOwner/$GitHubRepo (input hidden)."
  $token = Read-Host "GitHub token" -MaskInput
  if (-not $token) { throw "A GitHub token is required." }
  $secretValue = @{
    githubToken         = $token
    githubWebhookSecret = New-RandomKey
    mcpApiKey           = New-RandomKey
  } | ConvertTo-Json -Compress
  $file = Write-JsonFile "secret-value.json" $secretValue
  $created = Invoke-Aws secretsmanager create-secret --name $SecretName `
    --description "Repository Custodian credentials (GitHub token, webhook secret, MCP key)" `
    --secret-string $file --tags $TagsList
  Remove-Item (Join-Path $WorkDir "secret-value.json") -Force
  $secretArn = $created.ARN
  Ok "Secret created: $secretArn"
}
Set-State "secretArn" $secretArn

Step "Parameter Store: $ConfigParamName"
$config = @{
  region           = $Region
  studentId        = $StudentId
  repoOwner        = $GitHubOwner
  repoName         = $GitHubRepo
  tableName        = $TableName
  bucketName       = $BucketName
  vectorBucketName = $VectorBucketName
  vectorIndexName  = $VectorIndexName
  embedModelId     = $EmbedModelId
  embedDimensions  = $EmbedDims
  chatModelId      = $ChatModelId
  heartbeatEnabled = $true
}
$param = Test-Aws ssm get-parameter --name $ConfigParamName
if ($param) {
  Update-AppConfig $config
} else {
  $valueFile = Write-JsonFile "config-value.json" ($config | ConvertTo-Json -Compress)
  Invoke-Aws ssm put-parameter --name $ConfigParamName --type String --value $valueFile `
    --description "Repository Custodian non-secret configuration (JSON)" --tags $TagsList | Out-Null
  Ok "Parameter created"
}
Set-State "configParamArn" "arn:aws:ssm:${Region}:${AccountId}:parameter$ConfigParamName"
