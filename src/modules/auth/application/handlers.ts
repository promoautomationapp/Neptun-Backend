import { Inject, UnauthorizedException } from "@nestjs/common";
import { Command, CommandHandler, Query, QueryHandler } from "@nestjs/cqrs";
import type { ICommandHandler, IQueryHandler } from "@nestjs/cqrs";
import { verify, hash, argon2id } from "argon2";
import { randomBytes } from "node:crypto";
import { IdentityService } from "../../users/identity.service";
import { AuthRepository } from "../auth.repository";
import type { Actor } from "../domain/actor";

export class LoginCommand extends Command<{ actor: Actor; token: string }> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly ip: string,
  ) {
    super();
  }
}
@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  private dummyHash?: Promise<string>;
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  async execute(command: LoginCommand) {
    await this.identity.rateLimit(`login-ip:${command.ip}`, 60, 900);
    await this.identity.rateLimit(
      `login-account:${command.ip}:${command.email}`,
      20,
      900,
    );
    const credentials = await this.repository.credentials(command.email);
    this.dummyHash ??= hash(randomBytes(32).toString("hex"), {
      type: argon2id,
    });
    const valid = await verify(
      credentials?.passwordHash ?? (await this.dummyHash),
      command.password,
    );
    if (!credentials || !valid)
      throw new UnauthorizedException("Incorrect email or password.");
    const token = randomBytes(32).toString("base64url");
    const actor = await this.repository.createSession(
      credentials.actor,
      token,
      credentials.passwordHash,
    );
    return { actor, token };
  }
}
export class LogoutCommand extends Command<void> {
  constructor(readonly token: string) {
    super();
  }
}
@CommandHandler(LogoutCommand)
export class LogoutHandler implements ICommandHandler<LogoutCommand> {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {}
  async execute(command: LogoutCommand): Promise<void> {
    await this.repository.removeSession(command.token);
  }
}
export class SessionQuery extends Query<Actor | null> {
  constructor(readonly token: string) {
    super();
  }
}
@QueryHandler(SessionQuery)
export class SessionHandler implements IQueryHandler<SessionQuery> {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {}
  execute(query: SessionQuery): Promise<Actor | null> {
    return this.repository.session(query.token);
  }
}
export class MembersQuery extends Query<
  { id: string; name: string; email: string; role: string; username: string }[]
> {
  constructor(readonly organizationId: string) {
    super();
  }
}
@QueryHandler(MembersQuery)
export class MembersHandler implements IQueryHandler<MembersQuery> {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {}
  execute(query: MembersQuery) {
    return this.repository.members(query.organizationId);
  }
}
