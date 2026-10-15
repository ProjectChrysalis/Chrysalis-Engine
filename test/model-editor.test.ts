import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import React from "react";
import ts from "typescript";

type ModelRow = { id: string; contextWindow: string; maxTokens: string; reasoning: boolean };
type Update = (models: ModelRow[]) => ModelRow[];
type EditorProps = { builtin: boolean; mode: "auto" | "manual"; models: ModelRow[]; setMode: () => void; setModels: (update: Update) => void };

const settings = fs.readFileSync(new URL("../client/src/settings.tsx", import.meta.url), "utf8");
const source = settings.slice(settings.indexOf("function ModelsEditor("), settings.indexOf("// ----------------------------------------------------------------------- mcp"));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const Select = () => null;
const Editor = new Function("React", "tr", "Select", "IconSmall", `${compiled}\nreturn ModelsEditor;`)(React, (text: string) => text, Select, () => null) as (props: EditorProps) => React.ReactElement;

function elements(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}

function render(builtin = true) {
  const queued: Update[] = [];
  const models: ModelRow[] = [{ id: "", contextWindow: "", maxTokens: "", reasoning: false }];
  const tree = elements(Editor({ builtin, mode: "auto", models, setMode: () => {}, setModels: (update) => queued.push(update) }));
  return { tree, queued, models };
}

describe("connection model editor", () => {
  it("keeps provider additions editable without a catalog/custom selector", () => {
    const { tree } = render();
    expect(tree.some((element) => element.type === Select)).toBe(false);
    expect(tree.filter((element) => element.type === "input")).toHaveLength(4);
    const add = tree.find((element) => element.type === "button" && element.props.children === "+ Add model");
    expect(add).toBeDefined();
    expect(render(false).tree.some((element) => element.type === Select)).toBe(true);
  });

  it("updates text and thinking fields after the input event has finished", () => {
    const { tree, queued, models } = render();
    const inputs = tree.filter((element) => element.type === "input");
    const values = ["gemini-custom", "1,048,576", "65,536", true];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const event: { currentTarget: { value: string; checked: boolean } | null } = { currentTarget: { value: String(values[i]), checked: values[i] === true } };
      (input.props.onChange as (event: unknown) => void)(event);
      event.currentTarget = null;
    }
    const updated = queued.reduce((previous, update) => update(previous), models);
    expect(updated).toEqual([{ id: "gemini-custom", contextWindow: "1048576", maxTokens: "65536", reasoning: true }]);
  });

  it("adds and removes rows while the provider catalog stays enabled", () => {
    const { tree, queued, models } = render();
    const add = tree.find((element) => element.type === "button" && element.props.children === "+ Add model")!;
    (add.props.onClick as () => void)();
    const added = queued[0]!(models);
    expect(added).toHaveLength(2);
    const remove = tree.find((element) => element.props.title === "Remove model")!;
    (remove.props.onClick as () => void)();
    expect(queued[1]!(models)).toEqual([]);
  });
});
