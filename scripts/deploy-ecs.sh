#!/usr/bin/env bash
set -euo pipefail

ecs_cluster="${ECS_CLUSTER:?ECS_CLUSTER is required}"
api_image="${API_IMAGE:?API_IMAGE is required}"
worker_image="${WORKER_IMAGE:?WORKER_IMAGE is required}"
subnet_ids="${ECS_SUBNET_IDS:?ECS_SUBNET_IDS is required as a comma-separated list}"
security_group="${ECS_SECURITY_GROUP_ID:?ECS_SECURITY_GROUP_ID is required}"
api_service="${ECS_API_SERVICE:-api}"
worker_service="${ECS_WORKER_SERVICE:-worker}"
api_task_family="${ECS_API_TASK_DEFINITION:?ECS_API_TASK_DEFINITION is required}"
migration_task_family="${ECS_MIGRATION_TASK_DEFINITION:?ECS_MIGRATION_TASK_DEFINITION is required}"
worker_task_family="${ECS_WORKER_TASK_DEFINITION:?ECS_WORKER_TASK_DEFINITION is required}"

image_digest_pattern='@sha256:[0-9a-f]{64}$'
if [[ ! "$api_image" =~ $image_digest_pattern ]] || [[ ! "$worker_image" =~ $image_digest_pattern ]]; then
  echo "API_IMAGE and WORKER_IMAGE must be immutable sha256 digest references." >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

register_revision() {
  local service="$1"
  local task_family="$2"
  local container_name="$3"
  local image="$4"
  local current_file="$temporary_directory/${service}-current.json"
  local request_file="$temporary_directory/${service}-request.json"

  aws ecs describe-task-definition \
    --task-definition "$task_family" \
    --query taskDefinition \
    --output json > "$current_file"

  if ! jq -e --arg container "$container_name" \
    '.containerDefinitions | any(.name == $container)' "$current_file" >/dev/null; then
    echo "Task definition $task_family has no $container_name container." >&2
    exit 1
  fi

  jq --arg container "$container_name" --arg image "$image" '
    del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy
    )
    | .containerDefinitions |= map(
        if .name == $container then .image = $image else . end
      )
  ' "$current_file" > "$request_file"

  aws ecs register-task-definition \
    --cli-input-json "file://$request_file" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text
}

api_task_definition="$(register_revision "$api_service" "$api_task_family" api "$api_image")"
migration_task_definition="$(register_revision migration "$migration_task_family" migration "$api_image")"
worker_task_definition="$(register_revision "$worker_service" "$worker_task_family" worker "$worker_image")"

# Apply forward-compatible database migrations before shifting production traffic.
network_configuration="awsvpcConfiguration={subnets=[$subnet_ids],securityGroups=[$security_group],assignPublicIp=DISABLED}"
migration_task="$(aws ecs run-task \
  --cluster "$ecs_cluster" \
  --launch-type FARGATE \
  --task-definition "$migration_task_definition" \
  --network-configuration "$network_configuration" \
  --query 'tasks[0].taskArn' \
  --output text)"

test -n "$migration_task"
test "$migration_task" != "None"
aws ecs wait tasks-stopped --cluster "$ecs_cluster" --tasks "$migration_task"
# The backticks below are JMESPath literals, not shell substitutions.
# shellcheck disable=SC2016
migration_exit_code="$(aws ecs describe-tasks \
  --cluster "$ecs_cluster" \
  --tasks "$migration_task" \
  --query 'tasks[0].containers[?name==`migration`].exitCode | [0]' \
  --output text)"
if [[ "$migration_exit_code" != "0" ]]; then
  aws ecs describe-tasks --cluster "$ecs_cluster" --tasks "$migration_task" --output json >&2
  echo "Database migration failed; services were not updated." >&2
  exit 1
fi

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

echo "ECS release is stable: migration $migration_task_definition, API $api_task_definition, worker $worker_task_definition."
