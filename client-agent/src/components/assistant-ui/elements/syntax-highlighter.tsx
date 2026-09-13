import { PrismLight } from "react-syntax-highlighter";
import { makePrismLightSyntaxHighlighter } from "@assistant-ui/react-syntax-highlighter";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";

import {
  coldarkCold,
  coldarkDark,
} from "react-syntax-highlighter/dist/cjs/styles/prism";

PrismLight.registerLanguage("js", tsx);
PrismLight.registerLanguage("jsx", tsx);
PrismLight.registerLanguage("ts", tsx);
PrismLight.registerLanguage("tsx", tsx);
PrismLight.registerLanguage("typescript", typescript);
PrismLight.registerLanguage("python", python);
PrismLight.registerLanguage("bash", bash);
PrismLight.registerLanguage("sh", bash);
PrismLight.registerLanguage("shell", bash);
PrismLight.registerLanguage("json", json);
PrismLight.registerLanguage("css", css);
PrismLight.registerLanguage("html", markup);
PrismLight.registerLanguage("xml", markup);
PrismLight.registerLanguage("markup", markup);
PrismLight.registerLanguage("sql", sql);
PrismLight.registerLanguage("rust", rust);
PrismLight.registerLanguage("go", go);
PrismLight.registerLanguage("yaml", yaml);
PrismLight.registerLanguage("markdown", markdown);

const syntaxHighlighterCustomStyle = {
  margin: 0,
  width: "100%",
  padding: "1.5rem 1rem",
};

const LightSyntaxHighlighter = makePrismLightSyntaxHighlighter({
  style: coldarkCold,
  customStyle: syntaxHighlighterCustomStyle,
  className: "dark:hidden",
});

const DarkSyntaxHighlighter = makePrismLightSyntaxHighlighter({
  style: coldarkDark,
  customStyle: syntaxHighlighterCustomStyle,
  className: "hidden dark:block",
});

export const SyntaxHighlighter = (props: SyntaxHighlighterProps) => (
  <>
    <LightSyntaxHighlighter {...props} />
    <DarkSyntaxHighlighter {...props} />
  </>
);
