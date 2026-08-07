import type { FastifyInstance } from "fastify";

import {
  appAttestBindingVersion,
  createIosIntegrityChallengeSchema,
  submitIosIntegrityAssessmentSchema,
} from "@rafay-pair/api-contracts";

import {
  evaluateAppAttestSubmission,
  issueAppAttestChallenge,
} from "../app-attest.js";
import { recordSecurityAudit } from "../audit.js";
import {
  consumeDeviceIntegrityChallenge,
  recordDeviceIntegrityAssessment,
} from "../device-integrity.js";
import { ApiError } from "../errors.js";
import { mutationGuard } from "../guards.js";
import type { AppAttestVerifierConfiguration } from "../integrity/app-attest-verifier.js";
import { authenticated } from "../types.js";

export async function registerIosIntegrityRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { config, pool } = dependencies;

  app.post(
    "/v1/integrity/ios/challenges",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      assertIos(auth.platform);
      const appAttest = requireAppAttest(config.appAttest);
      const body = createIosIntegrityChallengeSchema.parse(request.body);
      const challenge = await issueAppAttestChallenge(
        pool,
        auth,
        body,
        appAttest.environment,
      );
      return reply.status(201).send({
        challenge: {
          id: challenge.id,
          action: challenge.action,
          mode: challenge.mode,
          bindingVersion: appAttestBindingVersion,
          clientData: challenge.clientData,
          expiresAt: challenge.expiresAt.toISOString(),
        },
      });
    },
  );

  app.post(
    "/v1/integrity/ios/assessments",
    {
      bodyLimit: 128 * 1_024,
      preHandler: mutationGuard(dependencies),
    },
    async (request, reply) => {
      const auth = authenticated(request);
      assertIos(auth.platform);
      const appAttest = requireAppAttest(config.appAttest);
      const body = submitIosIntegrityAssessmentSchema.parse(request.body);
      let recorded:
        | {
            id: string;
            evaluatedAt: Date;
            signal: "low_risk" | "elevated_risk" | "invalid_binding";
          }
        | undefined;
      await consumeDeviceIntegrityChallenge(
        pool,
        auth,
        {
          id: body.challengeId,
          platform: "ios",
          action: body.action,
        },
        async (client) => {
          const evaluation = await evaluateAppAttestSubmission(
            client,
            auth,
            body,
            appAttest,
          );
          const assessment = await recordDeviceIntegrityAssessment(client, {
            challengeId: body.challengeId,
            auth,
            platform: "ios",
            provider: "app_attest",
            signal: evaluation.signal,
            bindingValid: evaluation.bindingValid,
            providerMetadata: evaluation.metadata,
          });
          await recordSecurityAudit(client, config, {
            actorUserId: auth.userId,
            action: "device_integrity.ios.assessed",
            targetType: "device_integrity_assessment",
            targetId: assessment.id,
            requestId: request.id,
            ip: request.ip,
            metadata: {
              provider: "app_attest",
              signal: evaluation.signal,
              bindingValid: evaluation.bindingValid,
              proofType: body.mode,
            },
          });
          recorded = { ...assessment, signal: evaluation.signal };
        },
      );
      if (!recorded) {
        throw new Error("App Attest assessment was not recorded");
      }
      return reply.status(202).send({
        assessment: {
          id: recorded.id,
          signal: recorded.signal,
          evaluatedAt: recorded.evaluatedAt.toISOString(),
        },
      });
    },
  );
}

function assertIos(platform: string): void {
  if (platform !== "ios") {
    throw new ApiError(
      400,
      "PLATFORM_MISMATCH",
      "iOS session required",
      "App Attest checks are accepted only from iOS sessions.",
    );
  }
}

function requireAppAttest(
  configuration: AppAttestVerifierConfiguration | undefined,
): AppAttestVerifierConfiguration {
  if (!configuration) {
    throw new ApiError(
      501,
      "APP_ATTEST_UNSUPPORTED",
      "App Attest is not configured",
      "This non-production environment does not provide iOS integrity checks.",
    );
  }
  return configuration;
}
