/** Terminal colors are optional; redirected output stays readable as plain text. */
const colored = process.env.NO_COLOR == null && (process.env.FORCE_COLOR != null
  ? process.env.FORCE_COLOR !== "0"
  : Boolean(process.stdout.isTTY));

export const consoleStyle = {
  dim: colored ? "\x1b[2m" : "",
  bold: colored ? "\x1b[1m" : "",
  cyan: colored ? "\x1b[36m" : "",
  green: colored ? "\x1b[32m" : "",
  yellow: colored ? "\x1b[33m" : "",
  red: colored ? "\x1b[31m" : "",
  gray: colored ? "\x1b[90m" : "",
  magenta: colored ? "\x1b[35m" : "",
  reset: colored ? "\x1b[0m" : "",
};
