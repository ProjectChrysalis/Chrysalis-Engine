import { expect, it } from "bun:test";
import { edgeToken } from "../src/edge-token.js";

it("computes the Edge read-aloud token for a known time", () => {
  expect(edgeToken(1760000000, "6A5AA1D4EAFF4E9FB37E23D68491D6F4")).toBe(
    "6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D",
  );
  // the same five-minute window gives the same token
  expect(edgeToken(1760000000 + 1, "6A5AA1D4EAFF4E9FB37E23D68491D6F4")).toBe(edgeToken(1760000000, "6A5AA1D4EAFF4E9FB37E23D68491D6F4"));
});
