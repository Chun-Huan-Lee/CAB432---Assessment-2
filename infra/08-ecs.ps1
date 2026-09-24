# Builds the agent container, pushes it to ECR and runs it as an ECS Fargate service.
. "$PSScriptRoot\config.ps1"
$state = Get-State
$registry = "$AccountId.dkr.ecr.$Region.amazonaws.com"

Step "IAM roles for the task"
if (-not $EcsExecutionRoleName -or -not $EcsTaskRoleName) {
  $roles = Test-Aws iam list-roles --query "Roles[].RoleName"
  if (-not $roles) { throw "Set `$EcsExecutionRoleName and `$EcsTaskRoleName in config.ps1 (iam:ListRoles is not permitted)." }
  if (-not $EcsExecutionRoleName) { $EcsExecutionRoleName = $roles | Where-Object { $_ -match "(?i)ecs.*exec" } | Select-Object -First 1 }
  if (-not $EcsTaskRoleName) { $EcsTaskRoleName = $roles | Where-Object { $_ -match "(?i)ecs.*task" -and $_ -notmatch "(?i)exec" } | Select-Object -First 1 }
  if (-not $EcsTaskRoleName) { $EcsTaskRoleName = $EcsExecutionRoleName }
  if (-not $EcsExecutionRoleName) { throw "No ECS role found automatically. Set the role names in config.ps1." }
}
Ok "Execution role: $EcsExecutionRoleName"
Ok "Task role:      $EcsTaskRoleName"
$executionRoleArn = "arn:aws:iam::${AccountId}:role/$EcsExecutionRoleName"
$taskRoleArn = "arn:aws:iam::${AccountId}:role/$EcsTaskRoleName"

Step "ECR repository $EcrRepoName"
$repo = Test-Aws ecr describe-repositories --repository-names $EcrRepoName
if (-not $repo) {
  $repo = Invoke-Aws ecr create-repository --repository-name $EcrRepoName --image-scanning-configuration scanOnPush=true --tags $TagsList
  $repoArn = $repo.repository.repositoryArn
  $policy = Write-JsonFile "ecr-lifecycle.json" @{ rules = @(@{ rulePriority = 1; description = "keep last 5 images"; selection = @{ tagStatus = "any"; countType = "imageCountMoreThan"; countNumber = 5 }; action = @{ type = "expire" } }) }
  try { Invoke-Aws ecr put-lifecycle-policy --repository-name $EcrRepoName --lifecycle-policy-text $policy | Out-Null } catch { Warn "ECR lifecycle policy not permitted (optional)" }
  Ok "Created"
} else { $repoArn = $repo.repositories[0].repositoryArn; Ok "Exists" }
Set-State "ecrRepoArn" $repoArn

Step "Docker build and push"
$tag = Get-Date -Format "yyyyMMdd-HHmmss"
$image = "$registry/${EcrRepoName}:$tag"
$password = & aws ecr get-login-password --profile $AwsProfile --region $Region
$password | docker login --username AWS --password-stdin $registry
if ($LASTEXITCODE -ne 0) { throw "docker login failed" }
docker build --platform linux/amd64 -t $image $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
docker push $image
if ($LASTEXITCODE -ne 0) { throw "docker push failed" }
Ok "Pushed $image"

Step "CloudWatch log group $LogGroupName"
if (-not ((Invoke-Aws logs describe-log-groups --log-group-name-prefix $LogGroupName).logGroups | Where-Object { $_.logGroupName -eq $LogGroupName })) {
  Invoke-Aws logs create-log-group --log-group-name $LogGroupName --tags $TagsMap | Out-Null
  Invoke-Aws logs put-retention-policy --log-group-name $LogGroupName --retention-in-days 14 | Out-Null
  Ok "Created (14 day retention)"
} else { Ok "Exists" }
Set-State "logGroupArn" "arn:aws:logs:${Region}:${AccountId}:log-group:$LogGroupName"

Step "ECS cluster $ClusterName"
$cluster = (Invoke-Aws ecs describe-clusters --clusters $ClusterName).clusters | Where-Object { $_.status -eq "ACTIVE" }
if (-not $cluster) {
  $cluster = (Invoke-Aws ecs create-cluster --cluster-name $ClusterName --tags $TagsEcs --capacity-providers FARGATE).cluster
  Ok "Created"
} else { Ok "Exists" }
Set-State "ecsClusterArn" $cluster.clusterArn

Step "Task definition $TaskFamily"
$taskDef = @{
  family                  = $TaskFamily
  networkMode             = "awsvpc"
  requiresCompatibilities = @("FARGATE")
  cpu                     = "256"
  memory                  = "512"
  executionRoleArn        = $executionRoleArn
  taskRoleArn             = $taskRoleArn
  runtimePlatform         = @{ cpuArchitecture = "X86_64"; operatingSystemFamily = "LINUX" }
  containerDefinitions    = @(@{
      name             = "agent"
      image            = $image
      essential        = $true
      portMappings     = @(@{ containerPort = $ContainerPort; protocol = "tcp" })
      environment      = @(
        @{ name = "CONFIG_PARAMETER"; value = $ConfigParamName },
        @{ name = "SECRET_ID"; value = $SecretName },
        @{ name = "AWS_REGION"; value = $Region }
      )
      healthCheck      = @{ command = @("CMD-SHELL", "wget -qO- http://127.0.0.1:$ContainerPort/healthz || exit 1"); interval = 30; timeout = 5; retries = 3; startPeriod = 20 }
      logConfiguration = @{ logDriver = "awslogs"; options = @{ "awslogs-group" = $LogGroupName; "awslogs-region" = $Region; "awslogs-stream-prefix" = "agent" } }
    })
  tags                    = @($TagPairs.GetEnumerator() | ForEach-Object { @{ key = $_.Key; value = $_.Value } })
}
$taskFile = Write-JsonFile "taskdef.json" $taskDef
$registered = (Invoke-Aws ecs register-task-definition --cli-input-json $taskFile).taskDefinition
Ok "Registered $($registered.taskDefinitionArn)"
Set-State "taskDefinitionArn" $registered.taskDefinitionArn

Step "Networking"
$subnets = $SubnetIds
if (-not $subnets -or $subnets.Count -eq 0) {
  $vpcId = (Invoke-Aws ec2 describe-vpcs --filters Name=is-default,Values=true).Vpcs[0].VpcId
  $subnets = @((Invoke-Aws ec2 describe-subnets --filters "Name=vpc-id,Values=$vpcId" "Name=default-for-az,Values=true").Subnets | ForEach-Object { $_.SubnetId })
} else {
  $vpcId = (Invoke-Aws ec2 describe-subnets --subnet-ids $subnets[0]).Subnets[0].VpcId
}
$sg = $SecurityGroupId
if (-not $sg) {
  $sgName = "$Prefix-agent-sg"
  $found = (Invoke-Aws ec2 describe-security-groups --filters "Name=group-name,Values=$sgName" "Name=vpc-id,Values=$vpcId").SecurityGroups
  if ($found.Count -gt 0) { $sg = $found[0].GroupId }
  else {
    $tagSpec = Write-JsonFile "sg-tags.json" @(@{ ResourceType = "security-group"; Tags = @($TagPairs.GetEnumerator() | ForEach-Object { @{ Key = $_.Key; Value = $_.Value } }) })
    $sg = (Invoke-Aws ec2 create-security-group --group-name $sgName --description "Repository Custodian agent: inbound HTTP/WebSocket on $ContainerPort" --vpc-id $vpcId --tag-specifications $tagSpec).GroupId
    Invoke-Aws ec2 authorize-security-group-ingress --group-id $sg --protocol tcp --port $ContainerPort --cidr 0.0.0.0/0 | Out-Null
  }
}
Ok "Subnets: $($subnets -join ', ')  Security group: $sg"
Set-State "securityGroupId" $sg

Step "ECS service $ServiceName"
$network = Write-JsonFile "ecs-network.json" @{ awsvpcConfiguration = @{ subnets = @($subnets); securityGroups = @($sg); assignPublicIp = "ENABLED" } }
$service = (Invoke-Aws ecs describe-services --cluster $ClusterName --services $ServiceName).services | Where-Object { $_.status -eq "ACTIVE" }
if (-not $service) {
  $service = (Invoke-Aws ecs create-service --cluster $ClusterName --service-name $ServiceName `
      --task-definition $registered.taskDefinitionArn --desired-count 1 --launch-type FARGATE `
      --network-configuration $network --tags $TagsEcs --propagate-tags SERVICE --enable-ecs-managed-tags `
      --deployment-configuration "minimumHealthyPercent=0,maximumPercent=100").service
  Ok "Created"
} else {
  $service = (Invoke-Aws ecs update-service --cluster $ClusterName --service $ServiceName `
      --task-definition $registered.taskDefinitionArn --desired-count 1 --network-configuration $network --force-new-deployment).service
  Ok "Updated (new deployment)"
}
Set-State "ecsServiceArn" $service.serviceArn

Step "Waiting for the task to be RUNNING (up to ~3 minutes)"
$ip = $null
for ($i = 0; $i -lt 36 -and -not $ip; $i++) {
  Start-Sleep -Seconds 5
  $taskArns = (Invoke-Aws ecs list-tasks --cluster $ClusterName --service-name $ServiceName --desired-status RUNNING).taskArns
  if (-not $taskArns -or $taskArns.Count -eq 0) { continue }
  $tasks = (Invoke-Aws ecs describe-tasks --cluster $ClusterName --tasks @($taskArns)).tasks |
    Where-Object { $_.lastStatus -eq "RUNNING" -and $_.taskDefinitionArn -eq $registered.taskDefinitionArn }
  foreach ($task in $tasks) {
    $eni = ($task.attachments.details | Where-Object { $_.name -eq "networkInterfaceId" }).value
    if ($eni) { $ip = (Invoke-Aws ec2 describe-network-interfaces --network-interface-ids $eni).NetworkInterfaces[0].Association.PublicIp }
  }
}
if ($ip) {
  Set-State "agentPublicIp" $ip
  Ok "Chat UI: http://${ip}:$ContainerPort"
  Write-Host "  Optional: run .\11-dns.ps1 to point $StudentId-a2.cab432.com at this IP."
} else {
  Warn "Task not running yet. Check: aws ecs describe-services --cluster $ClusterName --services $ServiceName (events), and log group $LogGroupName"
}
