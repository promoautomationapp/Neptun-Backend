import {
  Controller,
  Get,
  Post,
  Req,
  Inject,
  Module,
  HttpCode,
} from "@nestjs/common";
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
    return this.brands.list(request.actor.organizationId);
  }
  @Get("refresh") status(@Req() request: AuthenticatedRequest) {
    return this.catalog.status(request.actor.organizationId);
  }
  @Post("refresh") @HttpCode(202) refresh(
    @Req() request: AuthenticatedRequest,
  ) {
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
