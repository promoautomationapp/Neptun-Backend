import express from "express";
import request from "supertest";
import sharp from "sharp";
import { browserMetadata } from "../../src/shared/browser-metadata";

function app() {
  const instance = express();
  instance.use(browserMetadata());
  instance.get("/api/status", (_request, response) => {
    response.status(202).json({ service: "Neptun Broshura API", ready: true });
  });
  return instance;
}

test("private API responses retain their status and JSON with crawler exclusion", async () => {
  const response = await request(app()).get("/api/status");
  expect(response.status).toBe(202);
  expect(response.headers["content-type"]).toMatch(/application\/json/);
  expect(response.headers["x-robots-tag"]).toBe(
    "noindex, nofollow, noimageindex",
  );
  expect(response.body).toEqual({
    service: "Neptun Broshura API",
    ready: true,
  });
});

test("browser favicon and robots endpoints work without changing API routing", async () => {
  const application = app();
  const svg = await request(application).get("/favicon.svg");
  expect(svg.status).toBe(200);
  expect(svg.headers["content-type"]).toMatch(/image\/svg\+xml/);
  expect((svg.body as Buffer).toString("utf8")).toContain("<title>Neptun</title>");
  expect(svg.headers["cache-control"]).toBe("public, max-age=86400");
  const ico = await request(application).get("/favicon.ico");
  expect(ico.status).toBe(200);
  expect(ico.headers["content-type"]).toMatch(/image\/x-icon/);
  expect(ico.body.subarray(0, 6)).toEqual(Buffer.from([0, 0, 1, 0, 3, 0]));
  const touch = await request(application).get("/apple-touch-icon.png");
  expect(touch.status).toBe(200);
  expect(await sharp(touch.body).metadata()).toMatchObject({
    width: 180,
    height: 180,
    format: "png",
  });
  const robots = await request(application).get("/robots.txt");
  expect(robots.status).toBe(200);
  expect(robots.headers["content-type"]).toMatch(/text\/plain/);
  expect(robots.text).toBe("User-agent: *\nDisallow: /\n");
  expect((await request(application).get("/api/unknown")).status).toBe(404);
});
