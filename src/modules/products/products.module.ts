import {
  Module,
  Controller,
  Get,
  Post,
  Req,
  Query as HttpQuery,
  Body,
  Inject,
} from "@nestjs/common";
import { Query, QueryHandler, QueryBus } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import { z } from "zod";
import { CatalogModule } from "../catalog/catalog.module";
import { ProductsRepository } from "./products.repository";
import type { ProductFilters, ProductView } from "./products.repository";
import type { AuthenticatedRequest } from "../auth/domain/actor";
export class SearchProductsQuery extends Query<
  Awaited<ReturnType<ProductsRepository["list"]>>
> {
  constructor(
    readonly organizationId: string,
    readonly filters: ProductFilters,
  ) {
    super();
  }
}
@QueryHandler(SearchProductsQuery)
export class SearchProductsHandler implements IQueryHandler<SearchProductsQuery> {
  constructor(
    @Inject(ProductsRepository) private readonly repository: ProductsRepository,
  ) {}
  execute(query: SearchProductsQuery) {
    return this.repository.list(query.organizationId, query.filters);
  }
}
export class BatchProductsQuery extends Query<ProductView[]> {
  constructor(
    readonly organizationId: string,
    readonly codes: string[],
  ) {
    super();
  }
}
@QueryHandler(BatchProductsQuery)
export class BatchProductsHandler implements IQueryHandler<BatchProductsQuery> {
  constructor(
    @Inject(ProductsRepository) private readonly repository: ProductsRepository,
  ) {}
  execute(query: BatchProductsQuery) {
    return this.repository.batch(query.organizationId, query.codes);
  }
}
export class ProductFacetsQuery extends Query<
  Awaited<ReturnType<ProductsRepository["facets"]>>
> {
  constructor(readonly organizationId: string) {
    super();
  }
}
@QueryHandler(ProductFacetsQuery)
export class ProductFacetsHandler implements IQueryHandler<ProductFacetsQuery> {
  constructor(
    @Inject(ProductsRepository) private readonly repository: ProductsRepository,
  ) {}
  execute(query: ProductFacetsQuery) {
    return this.repository.facets(query.organizationId);
  }
}
const filters = z.object({
  q: z.string().max(120).default(""),
  code: z.string().max(100).default(""),
  category: z.string().max(200).default(""),
  subcategory: z.string().max(200).default(""),
  categoryPath: z.string().max(1000).default(""),
  brand: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(60),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
@Controller("api/products")
export class ProductsController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(ProductsRepository) private readonly repository: ProductsRepository,
  ) {}
  @Get() search(
    @Req() request: AuthenticatedRequest,
    @HttpQuery() query: unknown,
  ) {
    return this.queries.execute(
      new SearchProductsQuery(
        request.actor.organizationId,
        filters.parse(query),
      ),
    );
  }
  @Get("facets") facets(@Req() request: AuthenticatedRequest) {
    return this.queries.execute(
      new ProductFacetsQuery(request.actor.organizationId),
    );
  }
  @Post("batch") async batch(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = z
      .object({ codes: z.array(z.string().max(100)).max(2000) })
      .parse(body);
    return {
      products: await this.queries.execute(
        new BatchProductsQuery(request.actor.organizationId, input.codes),
      ),
    };
  }
}
@Module({
  imports: [CatalogModule],
  controllers: [ProductsController],
  providers: [
    ProductsRepository,
    SearchProductsHandler,
    BatchProductsHandler,
    ProductFacetsHandler,
  ],
  exports: [ProductsRepository],
})
export class ProductsModule {}
