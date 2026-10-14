import { Module, Controller, Get, Inject } from "@nestjs/common";
import { Database } from "../../database/database";
import { Public } from "../auth/auth.guard";
@Controller()
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get("health") @Public() health() {
    return { status: "ok" };
  }
  @Get("ready") @Public() async ready() {
    await this.db.query("SELECT 1");
    return { status: "ready" };
  }
}
@Module({ controllers: [HealthController] })
export class HealthModule {}
