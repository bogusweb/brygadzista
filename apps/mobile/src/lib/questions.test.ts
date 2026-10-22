import { describe, expect, it } from "vitest";
import { cropPath, shareMessage } from "./questions";

describe("questions to the designer", () => {
  it("writes the message with the project and the page", () => {
    const message = shareMessage({ question: "Którą grubość przyjąć przy cokole? ", pageNo: 30, pageTitle: "DETAL 3" }, "Hala Pilawa");
    expect(message).toBe(
      "Dzień dobry,\n\nmam pytanie do projektu (projekt „Hala Pilawa”, str. 30 (DETAL 3)):\n\nKtórą grubość przyjąć przy cokole?\n\nPozdrawiam",
    );
    expect(shareMessage({ question: "Kto odbiera izolację?", pageNo: null, pageTitle: null })).toBe(
      "Dzień dobry,\n\nmam pytanie do projektu:\n\nKto odbiera izolację?\n\nPozdrawiam",
    );
  });

  it("points the crop at the region of the page", () => {
    expect(cropPath("d1", 4, null)).toBe("/api/documents/d1/pages/4/crop");
    expect(cropPath("d1", 4, { x: 0.5, y: 0.25, width: 0.25, height: 0.1 })).toBe(
      "/api/documents/d1/pages/4/crop?x=0.5000&y=0.2500&w=0.2500&h=0.1000",
    );
  });
});
