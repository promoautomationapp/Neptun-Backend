import { BadGatewayException, BadRequestException } from "@nestjs/common";
import type { Response } from "express";
import type { StoragePort } from "../storage/storage.port";
import type { AssetRow } from "./assets.repository";
import { StorageReadLimitError } from "../storage/storage-read-limit";
import {
  MAX_STORED_ASSET_BYTES,
  withAssetReadWork,
} from "../../security/image-work";

/** Hold the byte reservation until Express finishes or the client disconnects,
 * rather than releasing it while a slow response still owns its image buffer. */
export async function sendStoredAsset(
  storage: StoragePort,
  asset: Pick<AssetRow, "size" | "storage_key">,
  response: Response,
  configure: (response: Response) => void,
): Promise<void> {
  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_STORED_ASSET_BYTES)
    throw new BadRequestException({
      error: "This image exceeds the supported size. Choose a smaller image.",
      code: "IMAGE_SIZE_LIMIT",
    });
  await withAssetReadWork(size, async () => {
    if (response.destroyed) return;
    let bytes: Buffer;
    try {
      bytes = await storage.read(asset.storage_key, size);
      if (bytes.length > size) throw new StorageReadLimitError();
    } catch (error) {
      if (error instanceof StorageReadLimitError)
        throw new BadGatewayException("This image could not be loaded.");
      throw error;
    }
    if (response.destroyed) return;
    configure(response);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const settle = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        response.removeListener("finish", complete);
        response.removeListener("close", complete);
        response.removeListener("error", fail);
        if (error) reject(error);
        else resolve();
      };
      const complete = () => settle();
      const fail = (error: Error) => settle(error);
      // A stalled download cannot retain a reservation indefinitely.
      const timer = setTimeout(() => {
        response.destroy();
        settle();
      }, 120_000);
      response.once("finish", complete);
      response.once("close", complete);
      response.once("error", fail);
      try {
        response.send(bytes);
        if (response.writableFinished || response.destroyed) complete();
      } catch (error) {
        settle(
          error instanceof Error ? error : new Error("Image response failed."),
        );
      }
    });
  });
}
