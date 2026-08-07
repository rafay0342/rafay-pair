import type { ApiProblem } from "../domain/types";

export class ApiError extends Error {
  public readonly status: number;
  public readonly problem: ApiProblem | undefined;

  public constructor(
    status: number,
    problem?: ApiProblem,
    fallbackMessage?: string,
  ) {
    super(
      problem?.detail ??
        problem?.title ??
        fallbackMessage ??
        `Request failed (${String(status)})`,
    );
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}
