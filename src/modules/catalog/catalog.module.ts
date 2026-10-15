import {
  Controller,
  Get,
  Post,
  Req,
  Inject,
  Module,
  HttpCode,
} from "@nestjs/common";
import { requireWorkspaceAccess } from "../auth/domain/workspace-access";
import type { AuthenticatedRequest } from "../auth/domain/actor";
import { CatalogBrandsRepository } from "./catalog-brands";
import { CatalogRepository } from "./catalog.repository";
@Controller("api/catalog")
export class CatalogController {
  constructor(
    @Inject(CatalogRepository) private readonly catalog: CatalogRepository,
    @Inject(CatalogBrandsRepository)
    private readonly brands: CatalogBrandsRepository,
  ) {}
  @Get("brands") brandImages(@Req() request: AuthenticatedRequest) {
    return this.brands.list(
      request.actor.organizationId,
      requireWorkspaceAccess(request.actor, "canViewCatalog")
        .catalogCategoryPaths,
    );
  }
  @Get("refresh") status(@Req() request: AuthenticatedRequest) {
    requireWorkspaceAccess(request.actor, "canViewCatalog");
    return this.catalog.status(request.actor.organizationId);
  }
  @Post("refresh") @HttpCode(202) refresh(
    @Req() request: AuthenticatedRequest,
  ) {
    requireWorkspaceAccess(request.actor, "canViewCatalog");
    return this.catalog.enqueue(
      request.actor.organizationId,
      "manual",
      request.actor.userId,
    );
  }
}
@Module({
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogBrandsRepository],
  exports: [CatalogRepository],
})
export class CatalogModule {}
