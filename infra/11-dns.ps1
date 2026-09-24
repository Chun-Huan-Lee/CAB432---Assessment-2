# Optional: friendly name <student>-a2.cab432.com -> current Fargate task public IP.
# Re-run after every redeploy, because a Fargate task gets a new IP when it restarts.
. "$PSScriptRoot\config.ps1"
$state = Get-State
if (-not $state.agentPublicIp) { throw "Run 08-ecs.ps1 first." }
$zone = (Invoke-Aws route53 list-hosted-zones-by-name --dns-name "cab432.com").HostedZones | Where-Object { $_.Name -eq "cab432.com." } | Select-Object -First 1
if (-not $zone) { throw "cab432.com hosted zone not visible." }
$record = "$StudentId-a2.cab432.com"
$change = Write-JsonFile "dns-change.json" @{ Changes = @(@{ Action = "UPSERT"; ResourceRecordSet = @{ Name = $record; Type = "A"; TTL = 60; ResourceRecords = @(@{ Value = $state.agentPublicIp }) } }) }
Invoke-Aws route53 change-resource-record-sets --hosted-zone-id ($zone.Id -replace "/hostedzone/", "") --change-batch $change | Out-Null
Set-State "agentHostname" $record
Ok "http://${record}:$ContainerPort (propagates within a minute)"
