import { Module, Global } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthRepository } from "./auth.repository";
import { AuthGuard } from "./auth.guard";
import {
  LoginHandler,
  LogoutHandler,
  SessionHandler,
  MembersHandler,
} from "./application/handlers";
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthRepository,
    LoginHandler,
    LogoutHandler,
    SessionHandler,
    MembersHandler,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthRepository],
})
export class AuthModule {}
