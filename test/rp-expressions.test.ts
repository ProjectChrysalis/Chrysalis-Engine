/**
 * Sprite expressions — the two halves that have to agree: what a message
 * detects, and what a sprite FILE is named. A downloaded pack uses the
 * emotion names below as filenames, so both directions are checked against
 * that vocabulary.
 */
import { describe, it, expect } from "bun:test";
import {
  STANDARD_EXPRESSIONS,
  detectExpressionLabels,
  expressionNameFromFile,
  resolveExpressionSprite,
} from "../apps/roleplay/src/lib/expressions.js";

const pack = (...names: string[]) => names.map((name) => ({ name, url: `data:${name}` }));

describe("expression detection", () => {
  it("resolves a pack named by the standard emotions", () => {
    const sprites = pack("joy", "anger", "sadness", "surprise", "neutral");
    const pick = (text: string) => resolveExpressionSprite(detectExpressionLabels(text), sprites)?.name;
    expect(pick("She beams and claps her hands.")).toBe("joy");
    expect(pick("He snarls, furious.")).toBe("anger");
    expect(pick("Tears run down her face.")).toBe("sadness");
    expect(pick("Her eyes go wide, astonished.")).toBe("surprise");
  });

  it("resolves informally named sprites through the rules' synonyms", () => {
    const sprites = pack("happy", "angry", "sad", "neutral");
    const pick = (text: string) => resolveExpressionSprite(detectExpressionLabels(text), sprites)?.name;
    expect(pick("She grins.")).toBe("happy");
    expect(pick("He rages at the door.")).toBe("angry");
    expect(pick("She sobs quietly.")).toBe("sad");
  });

  it("falls back to the default, then neutral, then whatever exists", () => {
    const flat = "Nothing about this line carries an emotion.";
    expect(resolveExpressionSprite(detectExpressionLabels(flat), pack("joy", "neutral"))?.name).toBe("neutral");
    expect(resolveExpressionSprite(detectExpressionLabels(flat), pack("joy", "neutral"), "joy")?.name).toBe("joy");
    expect(resolveExpressionSprite(detectExpressionLabels(flat), pack("anger"))?.name).toBe("anger");
    expect(resolveExpressionSprite(["joy"], [])).toBeNull();
    expect(resolveExpressionSprite(["joy"], [{ name: "joy", url: null }])).toBeNull();
  });

  it("a narrow emotion wins over the broad one it also matches", () => {
    // "mourns" fires both grief and sadness; the character has both sprites
    const sprites = pack("grief", "sadness");
    expect(resolveExpressionSprite(detectExpressionLabels("She mourns him still."), sprites)?.name).toBe("grief");
    // with only the broad sprite present, the fallthrough still lands
    expect(resolveExpressionSprite(detectExpressionLabels("She mourns him still."), pack("sadness"))?.name).toBe("sadness");
  });
});

describe("sprite file naming", () => {
  it("reads the expression out of a pack filename", () => {
    expect(expressionNameFromFile("joy.png")).toBe("joy");
    expect(expressionNameFromFile("Aria-anger.webp")).toBe("anger");
    expect(expressionNameFromFile("aria_neutral.PNG")).toBe("neutral");
    expect(expressionNameFromFile("surprise (1).png")).toBe("surprise");
  });

  it("keeps an unrecognized name so the slot is still created", () => {
    expect(expressionNameFromFile("battle-stance.png")).toBe("stance");
  });

  it("every standard emotion round-trips through its own filename", () => {
    for (const name of STANDARD_EXPRESSIONS) {
      expect(expressionNameFromFile(`${name}.png`)).toBe(name);
    }
  });
});
