#!/usr/bin/env bash
set -euo pipefail

ecs_cluster="${ECS_CLUSTER:?ECS_CLUSTER is required}"
api_task_definition="${API_TASK_DEFINITION:?API_TASK_DEFINITION is required}"
worker_task_definition="${WORKER_TASK_DEFINITION:?WORKER_TASK_DEFINITION is required}"
api_service="${ECS_API_SERVICE:-api}"
worker_service="${ECS_WORKER_SERVICE:-worker}"

# Database migrations are deliberately not reversed here. Production migrations
# must remain backward-compatible with the previous application revision.
aws ecs update-service \
  --cluster "$ecs_cluster" \
  --service "$worker_service" \
  --task-definition "$worker_task_definition" \
  --force-new-deployment >/dev/null
aws ecs update-service \
  --cluster "$ecs_cluster" \
  --service "$api_service" \
  --task-definition "$api_task_definition" \
  --force-new-deployment >/dev/null

aws ecs wait services-stable \
  --cluster "$ecs_cluster" \
  --services "$api_service" "$worker_service"

echo "Rollback is stable: API $api_task_definition, worker $worker_task_definition."
