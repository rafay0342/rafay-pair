output "api_url" {
  value = "https://${var.api_domain}"
}

output "web_url" {
  value = "https://${var.web_domain}"
}

output "api_ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "worker_ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "application_security_group_id" {
  value = aws_security_group.app.id
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "api_task_definition_arn" {
  value = aws_ecs_task_definition.api.arn
}

output "migration_task_definition_arn" {
  value = aws_ecs_task_definition.migration.arn
}

output "worker_task_definition_arn" {
  value = aws_ecs_task_definition.worker.arn
}

output "api_ecs_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_ecs_service_name" {
  value = aws_ecs_service.worker.name
}

output "database_master_secret_arn" {
  value     = aws_db_instance.postgres.master_user_secret[0].secret_arn
  sensitive = true
}
