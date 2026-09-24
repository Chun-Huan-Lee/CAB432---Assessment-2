# API Gateway HTTP API: POST /webhook/github -> webhook Lambda, /mcp -> MCP server Lambda.
. "$PSScriptRoot\config.ps1"
$state = Get-State

Step "HTTP API $ApiName"
$api = (Invoke-Aws apigatewayv2 get-apis).Items | Where-Object { $_.Name -eq $ApiName } | Select-Object -First 1
if (-not $api) {
  $api = Invoke-Aws apigatewayv2 create-api --name $ApiName --protocol-type HTTP --tags $TagsMap `
    --description "Repository Custodian: GitHub webhook and MCP server"
  Ok "Created $($api.ApiId)"
} else { Ok "Exists $($api.ApiId)" }
$apiId = $api.ApiId

function Ensure-Integration([string] $LambdaArn) {
  $existing = (Invoke-Aws apigatewayv2 get-integrations --api-id $apiId).Items | Where-Object { $_.IntegrationUri -eq $LambdaArn } | Select-Object -First 1
  if ($existing) { return $existing.IntegrationId }
  return (Invoke-Aws apigatewayv2 create-integration --api-id $apiId --integration-type AWS_PROXY `
      --integration-uri $LambdaArn --payload-format-version 2.0 --timeout-in-millis 29000).IntegrationId
}

function Ensure-Route([string] $RouteKey, [string] $IntegrationId) {
  $routes = (Invoke-Aws apigatewayv2 get-routes --api-id $apiId).Items
  $existing = $routes | Where-Object { $_.RouteKey -eq $RouteKey } | Select-Object -First 1
  if ($existing) {
    Invoke-Aws apigatewayv2 update-route --api-id $apiId --route-id $existing.RouteId --target "integrations/$IntegrationId" | Out-Null
  } else {
    Invoke-Aws apigatewayv2 create-route --api-id $apiId --route-key $RouteKey --target "integrations/$IntegrationId" | Out-Null
  }
  Ok "Route $RouteKey"
}

function Ensure-InvokePermission([string] $FunctionName, [string] $StatementId, [string] $Principal, [string] $SourceArn) {
  $null = Test-Aws lambda remove-permission --function-name $FunctionName --statement-id $StatementId
  Invoke-Aws lambda add-permission --function-name $FunctionName --statement-id $StatementId `
    --action lambda:InvokeFunction --principal $Principal --source-arn $SourceArn | Out-Null
}

$webhookIntegration = Ensure-Integration $state.lambda_webhook
$mcpIntegration = Ensure-Integration $state.lambda_mcp
Ensure-Route "POST /webhook/github" $webhookIntegration
Ensure-Route "POST /mcp" $mcpIntegration
Ensure-Route "GET /mcp" $mcpIntegration
Ensure-Route "DELETE /mcp" $mcpIntegration

$stage = (Invoke-Aws apigatewayv2 get-stages --api-id $apiId).Items | Where-Object { $_.StageName -eq '$default' }
if (-not $stage) {
  Invoke-Aws apigatewayv2 create-stage --api-id $apiId --stage-name '$default' --auto-deploy --tags $TagsMap `
    --default-route-settings "ThrottlingBurstLimit=50,ThrottlingRateLimit=20" | Out-Null
  Ok "Stage `$default created (auto-deploy, throttled)"
}

$sourceArn = "arn:aws:execute-api:${Region}:${AccountId}:$apiId/*/*"
Ensure-InvokePermission $LambdaNames.webhook "apigw-invoke" "apigateway.amazonaws.com" $sourceArn
Ensure-InvokePermission $LambdaNames.mcp "apigw-invoke" "apigateway.amazonaws.com" $sourceArn

$baseUrl = "https://$apiId.execute-api.$Region.amazonaws.com"
Set-State "apiId" $apiId
Set-State "apiStageArn" "arn:aws:apigateway:${Region}::/apis/$apiId/stages/`$default"
Set-State "apiBaseUrl" $baseUrl
Update-AppConfig @{ mcpEndpoint = "$baseUrl/mcp" }
Ok "MCP endpoint:     $baseUrl/mcp"
Ok "Webhook endpoint: $baseUrl/webhook/github"
