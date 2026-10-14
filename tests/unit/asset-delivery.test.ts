import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import type { QueryBus } from "@nestjs/cqrs";
import type { Response } from "express";
import {
  AssetsController,
  type UploadService,
} from "../../src/modules/assets/assets.module";
import type {
  AssetsRepository,
  AssetRow,
} from "../../src/modules/assets/assets.repository";
import type { AuthenticatedRequest } from "../../src/modules/auth/domain/actor";
import type { StoragePort } from "../../src/modules/storage/storage.port";

describe("authenticated remote image delivery", () => {
  const bytes = Buffer.from("unchanged original image bytes");
  const asset = {
    id: randomUUID(),
    storage_key: "org/tenant/assets/approved.png",
    mime_type: "image/png",
  } as AssetRow;
  function fixture(found: AssetRow | null = asset) {
    const execute = jest.fn().mockResolvedValue(found);
    const remote = {
      read: jest.fn().mockResolvedValue(bytes),
      signedRead: jest
        .fn()
        .mockResolvedValue("https://private.r2.example/signed"),
    } as unknown as StoragePort;
    const controller = new AssetsController(
      { execute } as unknown as QueryBus,
      remote,
      {} as UploadService,
      {} as AssetsRepository,
    );
    const response = {
      vary: jest.fn(),
      set: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
      redirect: jest.fn(),
    };
    for (const method of Object.values(response))
      method.mockReturnValue(response);
    const request = {
      actor: { organizationId: "tenant" },
    } as AuthenticatedRequest;
    return { controller, remote, execute, response, request };
  }
  test("returns original remote bytes without a credentialed cross-origin redirect", async () => {
    const { controller, remote, execute, response, request } = fixture();
    await controller.get(request, asset.id, response as unknown as Response);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      organizationId: "tenant",
      id: asset.id,
    });
    expect(remote.read).toHaveBeenCalledWith(asset.storage_key);
    expect(response.send).toHaveBeenCalledWith(bytes);
    expect(response.type).toHaveBeenCalledWith("image/png");
    expect(response.set).toHaveBeenCalledWith(
      "Cache-Control",
      "private, max-age=31536000, immutable",
    );
    expect(response.vary).toHaveBeenCalledWith("Cookie");
    expect(response.redirect).not.toHaveBeenCalled();
    expect(remote.signedRead).not.toHaveBeenCalled();
  });
  test("does not read or reveal media outside the authenticated tenant", async () => {
    const { controller, remote, response, request } = fixture(null);
    await expect(
      controller.get(request, asset.id, response as unknown as Response),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(remote.read).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });
});
