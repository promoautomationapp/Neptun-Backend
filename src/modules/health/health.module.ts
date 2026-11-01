import {
  Module,
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Database } from "../../database/database";
import { Public } from "../auth/auth.guard";
@Controller()
export class HealthController {
  private readiness?: {
    promise: Promise<{ status: "ready" }>;
    settled: boolean;
    expiresAt: number;
  };
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get("health") @Public() health() {
    return { status: "ok" };
  }
  @Get("ready") @Public() ready(): Promise<{ status: "ready" }> {
    const cached = this.readiness;
    if (cached && (!cached.settled || cached.expiresAt > Date.now()))
      return cached.promise;
    // The public probe must not turn each anonymous request into another query.
    // Coalesce in-flight checks, cache success for five seconds, and retry failures
    // sooner so a recovered database becomes ready without a long false outage.
    const entry = {
      promise: undefined as unknown as Promise<{ status: "ready" }>,
      settled: false,
      expiresAt: 0,
    };
    entry.promise = this.db.query("SELECT 1").then(
      () => {
        entry.settled = true;
        entry.expiresAt = Date.now() + 5000;
        return { status: "ready" as const };
      },
      () => {
        entry.settled = true;
        entry.expiresAt = Date.now() + 1000;
        throw new ServiceUnavailableException("Database is not ready.");
      },
    );
    this.readiness = entry;
    return entry.promise;
  }
}
@Module({ controllers: [HealthController] })
export class HealthModule {}
