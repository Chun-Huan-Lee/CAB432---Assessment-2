# SQS queues (+ dead-letter queues) and the EventBridge rule S3 snapshot -> ingest queue.
. "$PSScriptRoot\config.ps1"

function Ensure-Queue([string] $Name, [hashtable] $Attributes) {
  $existing = Test-Aws sqs get-queue-url --queue-name $Name
  if ($existing) { $url = $existing.QueueUrl; Ok "$Name exists" }
  else {
    $attrFile = Write-JsonFile "sqs-$Name.json" $Attributes
    $url = (Invoke-Aws sqs create-queue --queue-name $Name --attributes $attrFile --tags $TagsMap).QueueUrl
    Ok "$Name created"
  }
  if ($existing -and $Attributes.Count -gt 0) {
    $attrFile = Write-JsonFile "sqs-$Name.json" $Attributes
    Invoke-Aws sqs set-queue-attributes --queue-url $url --attributes $attrFile | Out-Null
  }
  $arn = (Invoke-Aws sqs get-queue-attributes --queue-url $url --attribute-names QueueArn).Attributes.QueueArn
  return @{ Url = $url; Arn = $arn }
}

Step "Dead-letter queues"
$jobsDlq   = Ensure-Queue $JobsDlqName   @{ MessageRetentionPeriod = "1209600" }
$ingestDlq = Ensure-Queue $IngestDlqName @{ MessageRetentionPeriod = "1209600" }

Step "Work queues"
# Visibility timeout > Lambda timeout, so a message is not redelivered while still being processed.
$jobs = Ensure-Queue $JobsQueueName @{
  VisibilityTimeout = "900"
  RedrivePolicy     = (@{ deadLetterTargetArn = $jobsDlq.Arn; maxReceiveCount = 3 } | ConvertTo-Json -Compress)
}
$ingest = Ensure-Queue $IngestQueueName @{
  VisibilityTimeout = "1800"
  RedrivePolicy     = (@{ deadLetterTargetArn = $ingestDlq.Arn; maxReceiveCount = 3 } | ConvertTo-Json -Compress)
}
Set-State "jobsQueueArn" $jobs.Arn
Set-State "jobsDlqArn" $jobsDlq.Arn
Set-State "ingestQueueArn" $ingest.Arn
Set-State "ingestDlqArn" $ingestDlq.Arn
Update-AppConfig @{ jobsQueueUrl = $jobs.Url }

Step "EventBridge rule $SnapshotRule (S3 snapshots/ object created -> ingest queue)"
$pattern = Write-JsonFile "snapshot-pattern.json" @{
  source        = @("aws.s3")
  "detail-type" = @("Object Created")
  detail        = @{ bucket = @{ name = @($BucketName) }; object = @{ key = @(@{ prefix = "snapshots/" }) } }
}
$rule = Invoke-Aws events put-rule --name $SnapshotRule --event-pattern $pattern --state ENABLED `
  --description "Repository snapshot uploaded to S3: queue it for indexing" --tags $TagsList
Set-State "snapshotRuleArn" $rule.RuleArn

# Allow ONLY this rule to send to the ingest queue.
$policy = @{
  Version   = "2012-10-17"
  Statement = @(@{
      Sid       = "AllowSnapshotRule"
      Effect    = "Allow"
      Principal = @{ Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = $ingest.Arn
      Condition = @{ ArnEquals = @{ "aws:SourceArn" = $rule.RuleArn } }
    })
} | ConvertTo-Json -Depth 10 -Compress
$policyFile = Write-JsonFile "ingest-policy.json" @{ Policy = $policy }
Invoke-Aws sqs set-queue-attributes --queue-url $ingest.Url --attributes $policyFile | Out-Null
$targets = Write-JsonFile "snapshot-targets.json" @(@{ Id = "ingest-queue"; Arn = $ingest.Arn })
Invoke-Aws events put-targets --rule $SnapshotRule --targets $targets | Out-Null
Ok "Rule targets the ingest queue"
