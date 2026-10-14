import { Catch, HttpException } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { logger } from "./logger";

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "Invalid request.",
        issues: error.issues.map((x) => ({
          path: x.path,
          message: x.message,
        })),
      });
      return;
    }
    if (error instanceof HttpException) {
      const result = error.getResponse();
      response
        .status(error.getStatus())
        .json(
          typeof result === "object"
            ? { error: error.message, ...result }
            : { error: result },
        );
      return;
    }
    logger.error({ err: error }, "Request failed");
    response
      .status(500)
      .json({ error: "Could not complete the request. Please try again." });
  }
}
