import type { FastifyInstance } from "fastify";

import {
  androidIntegrityBindingVersion,
  createAndroidIntegrityChallengeSchema,
  submitAndroidIntegrityAssessmentSchema,
} from "@rafay-pair/api-contracts";

import { recordSecurityAudit } from "../audit.js";
import { withTransaction } from "../database.js";
import {
  consumeDeviceIntegrityChallenge,
  issueDeviceIntegrityChallenge,
  recordDeviceIntegrityAssessment,
} from "../device-integrity.js";
import { ApiError } from "../errors.js";
import { mutationGuard } from "../guards.js";
import {
  createPlayIntegrityRequestHash,
  evaluatePlayIntegrityResponse,
  PlayIntegrityProviderError,
  type PlayIntegrityVerifier,
} from "../play-integrity.js";
import { authenticated } from "../types.js";

export async function registerAndroidIntegrityRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { config, pool, playIntegrityVerifier } = dependencies;

  app.post(
    "/v1/integrity/android/challenges",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      assertAndroid(auth.platform);
      requirePlayIntegrity(config.playIntegrity, playIntegrityVerifier);
      const body = createAndroidIntegrityChallengeSchema.parse(request.body);
      const challenge = await issueDeviceIntegrityChallenge(
        pool,
        auth,
        "android",
        body.action,
      );
      return reply.status(201).send({
        challenge: {
          id: challenge.id,
          action: body.action,
          bindingVersion: androidIntegrityBindingVersion,
          expiresAt: challenge.expiresAt.toISOString(),
        },
      });
    },
  );

  app.post(
    "/v1/integrity/android/assessments",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      assertAndroid(auth.platform);
      const configured = requirePlayIntegrity(
        config.playIntegrity,
        playIntegrityVerifier,
      );
      const body = submitAndroidIntegrityAssessmentSchema.parse(request.body);
      const challenge = await consumeDeviceIntegrityChallenge(pool, auth, {
        id: body.challengeId,
        platform: "android",
        action: body.action,
      });
      const expectedRequestHash = createPlayIntegrityRequestHash(
        challenge.id,
        body.action,
      );

      let decoded;
      try {
        decoded = await configured.verifier.decode(body.integrityToken);
      } catch (error) {
        const reason =
          error instanceof PlayIntegrityProviderError
            ? error.reason
            : "provider_unavailable";
        if (reason === "token_rejected") {
          const assessment = await withTransaction(pool, async (client) => {
            const row = await recordDeviceIntegrityAssessment(client, {
              challengeId: challenge.id,
              auth,
              platform: "android",
              provider: "play_integrity",
              signal: "invalid_binding",
              bindingValid: false,
              providerMetadata: { providerResult: "token_rejected" },
            });
            await recordSecurityAudit(client, config, {
              actorUserId: auth.userId,
              action: "device_integrity.android.assessed",
              targetType: "device_integrity_assessment",
              targetId: row.id,
              requestId: request.id,
              ip: request.ip,
              metadata: {
                provider: "play_integrity",
                signal: "invalid_binding",
                bindingValid: false,
              },
            });
            return row;
          });
          return reply.status(202).send({
            assessment: {
              id: assessment.id,
              signal: "invalid_binding",
              evaluatedAt: assessment.evaluatedAt.toISOString(),
            },
          });
        }
        await recordSecurityAudit(pool, config, {
          actorUserId: auth.userId,
          action: "device_integrity.android.provider_error",
          targetType: "device_integrity_challenge",
          targetId: challenge.id,
          requestId: request.id,
          ip: request.ip,
          metadata: { provider: "play_integrity", reason },
        });
        throw new ApiError(
          503,
          "PLAY_INTEGRITY_UNAVAILABLE",
          "Device integrity check is temporarily unavailable",
          "Request a new integrity challenge and try again.",
        );
      }

      const evaluation = evaluatePlayIntegrityResponse(decoded, {
        packageName: configured.config.packageName,
        requestHash: expectedRequestHash,
        now: new Date(),
        maxTokenAgeMs: configured.config.maxTokenAgeMs,
        allowedCertificateSha256Digests:
          configured.config.allowedCertificateSha256Digests,
        minimumVersionCode: configured.config.minimumVersionCode,
      });
      const assessment = await withTransaction(pool, async (client) => {
        const row = await recordDeviceIntegrityAssessment(client, {
          challengeId: challenge.id,
          auth,
          platform: "android",
          provider: "play_integrity",
          signal: evaluation.signal,
          bindingValid: evaluation.bindingValid,
          providerMetadata: evaluation.metadata,
        });
        await recordSecurityAudit(client, config, {
          actorUserId: auth.userId,
          action: "device_integrity.android.assessed",
          targetType: "device_integrity_assessment",
          targetId: row.id,
          requestId: request.id,
          ip: request.ip,
          metadata: {
            provider: "play_integrity",
            signal: evaluation.signal,
            bindingValid: evaluation.bindingValid,
          },
        });
        return row;
      });
      return reply.status(202).send({
        assessment: {
          id: assessment.id,
          signal: evaluation.signal,
          evaluatedAt: assessment.evaluatedAt.toISOString(),
        },
      });
    },
  );
}

function assertAndroid(platform: string): void {
  if (platform !== "android") {
    throw new ApiError(
      400,
      "PLATFORM_MISMATCH",
      "Android session required",
      "Play Integrity checks are accepted only from Android sessions.",
    );
  }
}

function requirePlayIntegrity(
  config: FastifyInstance["dependencies"]["config"]["playIntegrity"],
  verifier: PlayIntegrityVerifier | undefined,
): {
  config: NonNullable<
    FastifyInstance["dependencies"]["config"]["playIntegrity"]
  >;
  verifier: PlayIntegrityVerifier;
} {
  if (!config || !verifier) {
    throw new ApiError(
      501,
      "PLAY_INTEGRITY_UNSUPPORTED",
      "Play Integrity is not configured",
      "This non-production environment does not provide Android integrity checks.",
    );
  }
  return { config, verifier };
}
