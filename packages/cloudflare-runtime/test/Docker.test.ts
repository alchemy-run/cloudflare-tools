import { describe, expect, it } from "@effect/vitest";
import { toPullRef } from "../src/Docker.ts";

describe("Docker", () => {
  describe("toPullRef", () => {
    it("drops the tag when a digest pins the image", () => {
      expect(
        toPullRef(
          "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
        ),
      ).toBe(
        "cloudflare/proxy-everything@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
      );
    });

    it("keeps tag-only refs unchanged", () => {
      expect(toPullRef("rocicorp/zero:1.8.0")).toBe("rocicorp/zero:1.8.0");
    });

    it("keeps digest-only refs unchanged", () => {
      expect(toPullRef("repo@sha256:abc")).toBe("repo@sha256:abc");
    });

    it("preserves registry ports", () => {
      expect(toPullRef("registry.example.com:5000/repo:v1@sha256:abc")).toBe(
        "registry.example.com:5000/repo@sha256:abc",
      );
    });
  });
});
