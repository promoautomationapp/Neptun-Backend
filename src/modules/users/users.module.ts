import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { UsersController } from "./users.controller";
import { IdentityService } from "./identity.service";
@Module({
  imports: [EmailModule],
  controllers: [UsersController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class UsersModule {}
